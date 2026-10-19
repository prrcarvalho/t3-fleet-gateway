import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { ProtocolErrorCode } from '@modelcontextprotocol/client';
import { GatewayError } from '../src/errors.ts';
import { OPEN_STATES } from '../src/jobs/states.ts';
import { connectAgent, jobState, startJob, startJobHarness, type JobHarness, type JobHarnessOptions } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

interface JobView {
  jobId: string;
  state: string;
  project: string;
  host: string;
  projectId: string | null;
  source: string;
  title: string;
  workspaceMode: string | null;
  branch: string;
  standing: boolean;
  adopted: boolean;
  threadId: string | null;
  startedByYou: boolean;
}

interface Adopted {
  job: JobView;
  created: boolean;
}

let sequence = 0;
const requestId = () => `adopt-${++sequence}`;

/** A thread a person started in the T3 app, in the pilot project's T3 project, at a runtime mode the host allows. */
function appThread(h: JobHarness, title = 'Synthetic app thread', projectId = 'project-1'): string {
  return h.fake.startInApp({ projectId, title, message: 'Synthetic message typed in the app', runtimeMode: 'auto' }).threadId;
}

function adopt(h: JobHarness, threadId: string, extra: Record<string, unknown> = {}): Promise<Adopted> {
  return h.agent.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: requestId(), ...extra });
}

async function harness(t: TestContext, options: JobHarnessOptions = {}): Promise<JobHarness> {
  return startJobHarness(t, options);
}

async function openJobsFor(h: JobHarness, threadId: string): Promise<string[]> {
  const { jobs } = await h.agent.call<{ jobs: JobView[] }>('work_list', { states: OPEN_STATES });
  return jobs.filter((job) => job.threadId === threadId).map((job) => job.jobId);
}

describe('work_adopt: taking over a thread', () => {
  test('adopts an idle thread a person started in the app, without launching or renaming anything', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    h.fake.finishTurn(threadId, 'Synthetic reply in the app');
    const titleBefore = h.fake.threads.get(threadId)!.title;

    const { job, created } = await adopt(h, threadId);
    assert.equal(created, true);
    assert.deepEqual(
      [job.state, job.adopted, job.standing, job.project, job.source, job.projectId, job.title, job.workspaceMode, job.threadId, job.startedByYou],
      ['idle', true, false, 'pilot', 'alias', 'project-1', 'Synthetic app thread', null, threadId, true],
    );
    assert.equal(h.fake.calls.includes('t3_thread_launch'), false, 'nothing was launched');
    assert.equal(h.fake.threads.get(threadId)!.title, titleBefore, 'the thread is not renamed');

    const status = await h.agent.call<JobView & { latestMessageExcerpt: string | null }>('work_status', { jobId: job.jobId });
    assert.equal(status.latestMessageExcerpt, 'Synthetic reply in the app');
    const messages = await h.agent.call<{ messages: { text: string }[] }>('work_messages', { jobId: job.jobId });
    assert.deepEqual(messages.messages.map((message) => message.text), ['Synthetic reply in the app']);
    const feed = await h.agent.call<{ events: { jobId: string; type: string; toState: string | null; reason: string | null }[] }>('work_feed');
    assert.deepEqual(feed.events.filter((event) => event.jobId === job.jobId).map((event) => [event.type, event.toState, event.reason]), [['created', 'idle', 'adopted']]);

    const sent = await h.agent.call<{ job: JobView; delivery: string }>('work_continue', { jobId: job.jobId, message: 'Synthetic follow-up', requestId: 'continue-1' });
    assert.deepEqual([sent.delivery, sent.job.state], ['started', 'running']);
    assert.deepEqual(h.fake.sends.map((send) => [send.threadId, send.message]), [[threadId, 'Synthetic follow-up']]);
    h.fake.finishTurn(threadId, 'Synthetic reply to the follow-up');
    await h.tick();
    const after = await h.agent.call<JobView & { latestMessageExcerpt: string | null }>('work_status', { jobId: job.jobId });
    assert.deepEqual([after.state, after.latestMessageExcerpt], ['idle', 'Synthetic reply to the follow-up']);
  });

  test('a thread in a T3 project no alias names is labelled with its project ref', async (t) => {
    const h = await harness(t);
    const { job } = await adopt(h, appThread(h, 'Synthetic unaliased thread', 'project-3'));
    assert.deepEqual([job.project, job.source, job.projectId], ['@main/project-3', 'discovered', 'project-3']);
    const listed = await h.agent.call<{ jobs: JobView[] }>('work_list', { mine: true });
    assert.deepEqual(listed.jobs.map((entry) => entry.jobId), [job.jobId], 'an adopted job is the adopting agent\'s own');
  });

  test('a thread adopted after its last run failed starts idle with the error and stays open', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    h.fake.failRun(threadId);
    const { job } = await adopt(h, threadId);
    const status = await h.agent.call<JobView & { lastError: { code: string } | null }>('work_status', { jobId: job.jobId });
    assert.deepEqual([status.state, status.lastError?.code], ['idle', 't3_run_failed']);
    h.gw.clock.advance(10 * 60_000);
    await h.tick();
    assert.equal((await h.agent.call<JobView>('work_status', { jobId: job.jobId })).state, 'idle', 'the earlier failure does not fail the job');
    await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic retry', requestId: 'retry-1' });
    h.fake.failRun(threadId);
    await h.tick();
    assert.equal((await h.agent.call<JobView>('work_status', { jobId: job.jobId })).state, 'failed', 'a run after adoption fails it like a launched job');
  });
});

describe('work_adopt: idempotency and one job per thread', () => {
  test('a repeated requestId returns the same job without asking T3; reused for other input it conflicts', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    const first = await h.agent.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'same-request' });
    const calls = h.fake.calls.length;
    const replay = await h.agent.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'same-request' });
    assert.deepEqual([replay.created, replay.job.jobId], [false, first.job.jobId]);
    assert.equal(h.fake.calls.length, calls, 'a replay makes no T3 call');
    const other = appThread(h, 'Synthetic other thread');
    assert.equal((await h.agent.callError('work_adopt', { host: 'main', threadId: other, requestId: 'same-request' })).code, 'request_id_conflict');
    assert.equal((await h.agent.callError('work_adopt', { host: 'main', threadId, requestId: 'same-request', title: 'Synthetic retitled' })).code, 'request_id_conflict');
    const start = await h.agent.call<{ job: JobView }>('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'same-request' });
    assert.notEqual(start.job.jobId, first.job.jobId, 'request ids are scoped per tool');
  });

  test('a thread an open job already follows returns that job: adopted, launched by the gateway, or standing', async (t) => {
    const h = await harness(t);
    const second = await connectAgent(t, h.gw, 'operate');
    const threadId = appThread(h);
    const adopted = await adopt(h, threadId);
    const calls = h.fake.calls.length;
    const again = await second.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'second-agent' });
    assert.deepEqual([again.created, again.job.jobId, again.job.startedByYou], [false, adopted.job.jobId, false]);
    assert.equal(h.fake.calls.length, calls, 'no T3 call');
    const replay = await second.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'second-agent' });
    assert.equal(replay.job.jobId, adopted.job.jobId, 'the request id was recorded against the existing job');

    const launched = await startJob(h.agent);
    await h.tick();
    const launchedThread = h.fake.threadForJob(launched.jobId).threadId;
    const viaLaunched = await adopt(h, launchedThread);
    assert.deepEqual([viaLaunched.created, viaLaunched.job.jobId, viaLaunched.job.adopted], [false, launched.jobId, false]);

    const coordinator = appThread(h, 'Synthetic coordinator');
    const standing = (await h.gw.services.jobs.adopt({ project: 'pilot', threadId: coordinator })).job;
    const viaStanding = await adopt(h, coordinator);
    assert.deepEqual([viaStanding.created, viaStanding.job.jobId, viaStanding.job.standing], [false, standing.id, true]);
  });

  test('a launch whose answer has not arrived yet is the job that follows its thread', async (t) => {
    const h = await harness(t);
    h.fake.holdResponses.add('t3_thread_launch');
    const launched = await startJob(h.agent);
    const launching = h.tick();
    await h.fake.whenHeld('t3_thread_launch');
    const threadId = h.fake.threadForJob(launched.jobId).threadId;
    const first = await h.agent.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'during-launch' });
    assert.deepEqual([first.created, first.job.jobId, first.job.state], [false, launched.jobId, 'dispatching']);
    const replay = await h.agent.call<Adopted>('work_adopt', { host: 'main', threadId, requestId: 'during-launch' });
    assert.equal(replay.job.jobId, launched.jobId, 'the request id was recorded against the launching job');
    h.fake.holdResponses.clear();
    h.fake.releaseHeld();
    await launching;
    assert.equal(await jobState(h.agent, launched.jobId), 'running');
    assert.deepEqual(await openJobsFor(h, threadId), [launched.jobId]);
  });

  test('a launch whose answer was lost is the job that follows its thread, and reconciliation keeps it the only one', async (t) => {
    const h = await harness(t);
    const launched = await startJob(h.agent);
    h.fake.dropResponseOnce.add('t3_thread_launch');
    await h.tick();
    assert.equal(await jobState(h.agent, launched.jobId), 'unknown');
    const threadId = h.fake.threadForJob(launched.jobId).threadId;
    const { created, job } = await adopt(h, threadId);
    assert.deepEqual([created, job.jobId], [false, launched.jobId]);
    await h.tickAfter(60_000);
    assert.equal(await jobState(h.agent, launched.jobId), 'running', 'reconciled');
    assert.deepEqual(await openJobsFor(h, threadId), [launched.jobId]);
  });

  test('a marker naming a finished job, a job that follows another thread, or no job does not block adoption', async (t) => {
    const h = await harness(t);
    const cancelled = await startJob(h.agent);
    await h.agent.call('work_cancel', { jobId: cancelled.jobId });
    const running = await startJob(h.agent);
    await h.tick();
    assert.deepEqual([await jobState(h.agent, cancelled.jobId), await jobState(h.agent, running.jobId)], ['cancelled', 'running']);
    for (const marked of [cancelled.jobId, running.jobId, 'synthetic0']) {
      const threadId = appThread(h, `Synthetic copy [job:${marked}]`);
      const { created, job } = await adopt(h, threadId);
      assert.deepEqual([created, job.adopted, job.threadId], [true, true, threadId], marked);
    }
  });

  test('a launch confirmed after a person removed its marker and an agent took the thread over ends, naming that job', async (t) => {
    const h = await harness(t);
    h.fake.holdResponses.add('t3_thread_launch');
    const launched = await startJob(h.agent);
    const launching = h.tick();
    await h.fake.whenHeld('t3_thread_launch');
    const thread = h.fake.threadForJob(launched.jobId);
    thread.title = 'Synthetic title a person typed';
    const adopted = await adopt(h, thread.threadId);
    assert.equal(adopted.created, true);
    h.fake.holdResponses.clear();
    h.fake.releaseHeld();
    await launching;
    const status = await h.agent.call<JobView & { lastError: { code: string; message: string } | null }>('work_status', { jobId: launched.jobId });
    assert.deepEqual([status.state, status.lastError?.code, status.threadId], ['failed', 'thread_already_followed', thread.threadId]);
    assert.match(status.lastError!.message, new RegExp(`job ${adopted.job.jobId}`));
    assert.deepEqual(await openJobsFor(h, thread.threadId), [adopted.job.jobId]);
  });

  test('after work_cancel ends the adopted job, the thread can be adopted again as a fresh job', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    h.fake.finishTurn(threadId, 'Synthetic reply');
    const first = await adopt(h, threadId);
    const cancelled = await h.agent.call<{ job: JobView; outcome: string }>('work_cancel', { jobId: first.job.jobId });
    assert.deepEqual([cancelled.outcome, cancelled.job.state], ['cancelled', 'cancelled']);
    assert.ok(h.fake.threads.has(threadId), 'the T3 thread stays');
    const again = await adopt(h, threadId);
    assert.equal(again.created, true);
    assert.notEqual(again.job.jobId, first.job.jobId);
  });
});

describe('work_adopt: running and waiting threads', () => {
  test('a running thread is adopted running, holds a slot even past the limit, and its turn end makes it idle', async (t) => {
    const dataDir = join(tempDir(t), 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, 'hook.key'), 'Synthetic-hook-key\n', { mode: 0o600 });
    const h = await harness(t, {
      maxConcurrentJobs: 1,
      dataDir,
      webhooks: { subscriptions: [{ id: 'hook', enabled: true, url: 'http://127.0.0.1:9/hook', allowLoopbackHttp: true, auth: { header: 'X-Synthetic-Key', secretFile: 'hook.key' } }] },
    });
    const launched = await startJob(h.agent);
    await h.tick();
    assert.equal((await h.agent.call<JobView>('work_status', { jobId: launched.jobId })).state, 'running', 'the host is at its limit');

    const threadId = appThread(h);
    h.fake.streamAssistant(threadId, 'Synthetic partial reply');
    const { job, created } = await adopt(h, threadId);
    assert.deepEqual([created, job.state], [true, 'running'], 'adoption is never refused or queued for lack of a slot');
    const status = await h.agent.call<{ hosts: { runningJobs: number; maxConcurrentJobs: number }[] }>('fleet_status');
    assert.deepEqual(status.hosts.map((host) => [host.runningJobs, host.maxConcurrentJobs]), [[2, 1]]);

    h.fake.endTurn(h.fake.threadForJob(launched.jobId).threadId);
    const queued = await startJob(h.agent);
    await h.tick();
    assert.equal((await h.agent.call<JobView>('work_status', { jobId: queued.jobId })).state, 'queued', 'the adopted job still holds the only slot');

    h.fake.settleItem(threadId, h.fake.threads.get(threadId)!.items.length - 1, 'Synthetic finished reply');
    h.fake.endTurn(threadId);
    await h.tick();
    const idle = await h.agent.call<JobView & { latestMessageExcerpt: string | null }>('work_status', { jobId: job.jobId });
    assert.deepEqual([idle.state, idle.latestMessageExcerpt], ['idle', 'Synthetic finished reply'], 'the message streamed at adoption is read once settled');
    await h.tick();
    assert.equal((await h.agent.call<JobView>('work_status', { jobId: queued.jobId })).state, 'running', 'the freed slot goes to the queued launch');

    const deliveries = h.gw.services.db.prepare('SELECT payload FROM webhook_deliveries ORDER BY id').all() as { payload: string }[];
    const adoptedPayloads = deliveries.map((row) => JSON.parse(row.payload) as { jobId: string; type: string; standing: boolean }).filter((payload) => payload.jobId === job.jobId);
    assert.deepEqual(adoptedPayloads.map((payload) => [payload.type, payload.standing]), [['idle', false]]);
  });

  test('a thread waiting on a question is adopted needs_input with its question, which work_respond answers', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    const question = h.fake.askQuestion(threadId, [{ id: 'q', header: 'Synthetic', question: 'Synthetic question?', options: [{ label: 'Yes', description: 'Synthetic yes' }] }]);
    const { job } = await adopt(h, threadId);
    assert.equal(job.state, 'needs_input');
    const status = await h.agent.call<{ pendingRequests: { requestId: string; questions: { id: string }[] | null }[] }>('work_status', { jobId: job.jobId });
    assert.deepEqual(status.pendingRequests.map((request) => [request.requestId, request.questions?.map((entry) => entry.id)]), [[question, ['q']]]);
    const answered = await h.agent.call<{ job: JobView }>('work_respond', { jobId: job.jobId, requestId: question, answers: { q: 'Yes' } });
    assert.equal(answered.job.state, 'running');
    assert.deepEqual(h.fake.responses.map((response) => [response.threadId, response.requestId]), [[threadId, question]]);
  });
});

describe('work_adopt: refusals', () => {
  test('archived, unknown and over-privileged threads are refused and no job is created', async (t) => {
    const h = await harness(t);
    const archived = appThread(h, 'Synthetic archived thread');
    h.fake.archiveThread(archived);
    const refusedArchived = await h.agent.callError('work_adopt', { host: 'main', threadId: archived, requestId: requestId() });
    assert.equal(refusedArchived.code, 'invalid_argument');
    assert.match(refusedArchived.text, /archived.*unarchive it in T3 first/);
    assert.equal((await h.agent.callError('work_adopt', { host: 'main', threadId: 'thread-synthetic-missing', requestId: requestId() })).code, 'not_found');
    const fullAccess = h.fake.startInApp({ projectId: 'project-1', title: 'Synthetic full-access thread', message: 'Synthetic', runtimeMode: 'full-access' }).threadId;
    const refusedMode = await h.agent.callError('work_adopt', { host: 'main', threadId: fullAccess, requestId: requestId() });
    assert.equal(refusedMode.code, 'invalid_argument');
    assert.match(refusedMode.text, /runtime mode "full-access", above the gateway's access "auto"/);
    assert.deepEqual((await h.agent.call<{ jobs: unknown[] }>('work_list')).jobs, []);
  });

  test('a thread read T3 refuses at the protocol level is a T3 tool failure, not a missing thread', async (t) => {
    const h = await harness(t);
    const threadId = appThread(h);
    h.fake.protocolErrors.set('t3_thread_read', ProtocolErrorCode.MethodNotFound);
    const refused = await h.agent.callError('work_adopt', { host: 'main', threadId, requestId: requestId() });
    assert.equal(refused.code, 't3_tool_failed');
    assert.match(refused.text, /method_not_found/);
    await assert.rejects(h.gw.services.jobs.adopt({ project: 'pilot', threadId }), (error: unknown) => error instanceof GatewayError && error.code === 't3_tool_failed');
    assert.deepEqual((await h.agent.call<{ jobs: unknown[] }>('work_list')).jobs, []);
  });

  test('an unknown host, a read-only grant and a host that opted out are refused before T3 is asked', async (t) => {
    const h = await harness(t, { host: { nativeReads: false } });
    const threadId = appThread(h);
    const calls = h.fake.calls.length;
    assert.equal((await h.agent.callError('work_adopt', { host: 'nowhere', threadId, requestId: requestId() })).code, 'not_found');
    const reader = await connectAgent(t, h.gw, 'read');
    assert.equal((await reader.callError('work_adopt', { host: 'main', threadId, requestId: requestId() })).code, 'insufficient_scope');
    const disabled = await h.agent.callError('work_adopt', { host: 'main', threadId, requestId: requestId() });
    assert.equal(disabled.code, 'native_reads_disabled');
    assert.equal(h.fake.calls.length, calls, 'nothing reached T3');
  });
});
