import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { GatewayError } from '../src/errors.ts';
import { sanitizeCapabilities, type CatalogOption, type CatalogProvider } from '../src/hosts/catalog.ts';
import { validateSelection, type ModelSelection } from '../src/jobs/launchSpec.ts';
import { capabilitiesSchema } from '../src/t3/schemas.ts';
import { startFakeT3, syntheticProviders, type FakeProvider } from './helpers/fakeT3.ts';
import { assertNotLogged, startJobHarness, type Agent } from './helpers/jobs.ts';

/**
 * Providers and models captured from one host's `orchestrator_capabilities` on T3 0.1.2-nightly.20261022
 * (the same shape 0.1.1-nightly.20261020 returned). Options are `{ id, values, default? }`, some models have
 * no options, and some providers have no models. No credentials.
 */
const captured = JSON.parse(readFileSync(new URL('./fixtures/orchestrator-capabilities-macbook-20261022.json', import.meta.url), 'utf8')) as {
  providerInstanceId: string;
  models: { id: string; label?: string; options?: unknown[] }[];
}[];

function catalogFrom(providers: unknown): CatalogProvider[] {
  return sanitizeCapabilities('macbook', capabilitiesSchema.parse({ providers }));
}

function model(providers: readonly CatalogProvider[], instanceId: string, modelId: string) {
  const found = providers.find((provider) => provider.providerInstanceId === instanceId)?.models.find((entry) => entry.id === modelId);
  assert.ok(found, `${instanceId}/${modelId}`);
  return found;
}

function option(options: readonly CatalogOption[], id: string): CatalogOption {
  const found = options.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

function selectionError(providers: readonly CatalogProvider[], selection: ModelSelection): GatewayError {
  try {
    validateSelection('macbook', providers, selection);
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    return error;
  }
  assert.fail(`expected invalid_argument for ${JSON.stringify(selection)}`);
}

describe('model options: descriptor and compact shapes', () => {
  test('a descriptor option keeps its label, choices, default and current value, including false', () => {
    const providers = catalogFrom(syntheticProviders());
    assert.deepEqual(model(providers, 'synthetic-provider', 'synthetic-model').options, [
      {
        id: 'synthetic-effort',
        label: 'Synthetic effort',
        description: 'How hard the synthetic model thinks',
        type: 'select',
        choices: [
          { id: 'low', label: 'Low', description: null, isDefault: false },
          { id: 'medium', label: 'Medium', description: null, isDefault: true },
          { id: 'high', label: 'High', description: 'Slow and thorough', isDefault: false },
        ],
        currentValue: 'medium',
      },
      {
        id: 'synthetic-fast',
        label: 'Synthetic fast mode',
        description: null,
        type: 'boolean',
        choices: null,
        currentValue: false,
      },
    ]);
    assert.deepEqual(model(providers, 'synthetic-provider', 'synthetic-large').options, []);
  });

  test('the nightly capture lists string options as selects and boolean options as booleans', () => {
    const providers = catalogFrom(captured);
    assert.deepEqual(providers.map((provider) => [provider.providerInstanceId, provider.models.length]), captured.map((provider) => [provider.providerInstanceId, provider.models.length]));
    for (const raw of captured) {
      for (const rawModel of raw.models) {
        const listed = model(providers, raw.providerInstanceId, rawModel.id);
        assert.equal(listed.options.length, rawModel.options?.length ?? 0, `${raw.providerInstanceId}/${rawModel.id}`);
        assert.equal(listed.label, rawModel.label ?? null);
      }
    }

    const effort = option(model(providers, 'claudeAgent', 'claude-opus-5-5').options, 'effort');
    assert.equal(effort.type, 'select');
    assert.equal(effort.label, 'effort');
    assert.equal(effort.description, null);
    assert.equal(effort.currentValue, null);
    assert.deepEqual(effort.choices?.map((choice) => [choice.id, choice.label, choice.isDefault]), [
      ['low', 'low', false],
      ['medium', 'medium', true],
      ['high', 'high', false],
      ['xhigh', 'xhigh', false],
      ['max', 'max', false],
      ['ultracode', 'ultracode', false],
      ['ultrathink', 'ultrathink', false],
    ]);
    const fast = option(model(providers, 'claudeAgent', 'claude-opus-5-5').options, 'fastMode');
    assert.deepEqual(fast, { id: 'fastMode', label: 'fastMode', description: null, type: 'boolean', choices: null, currentValue: null });

    const reasoning = option(model(providers, 'codex', 'gpt-6.1-sol').options, 'reasoningEffort');
    assert.deepEqual(reasoning.choices?.map((choice) => [choice.id, choice.isDefault]), [
      ['low', true],
      ['medium', false],
      ['high', false],
      ['xhigh', false],
      ['max', false],
      ['ultra', false],
    ]);
    assert.equal(reasoning.currentValue, null);
    const tier = option(model(providers, 'codex', 'gpt-6.1-sol').options, 'serviceTier');
    assert.deepEqual(tier.choices?.map((choice) => [choice.id, choice.isDefault]), [['default', true], ['priority', false]]);
    // The other Codex instance advertises reasoningEffort only, with the same default.
    assert.deepEqual(model(providers, 'codex_d5194ff1-d9a2-44be-b4a7-42b3615dddc9', 'gpt-6.1-sol').options.map((entry) => entry.id), ['reasoningEffort']);

    assert.deepEqual(model(providers, 'claudeAgent', 'gpt-5.6-sol').options, []);
    assert.equal(model(providers, 'grok', 'grok-build').label, 'Grok Build');
    assert.deepEqual(providers.find((provider) => provider.providerInstanceId === 'cursor')?.models, []);
    assert.equal(providers.find((provider) => provider.providerInstanceId === 'cursor')?.canRunChildTask, null);

    assert.deepEqual(
      validateSelection('macbook', providers, { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } }),
      { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } },
    );
    assert.deepEqual(
      validateSelection('macbook', providers, { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { fastMode: false, effort: 'high' } }),
      { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high', fastMode: false } },
    );
    assert.deepEqual(
      validateSelection('macbook', providers, { instanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'high' } }),
      { instanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'high' } },
    );
    assert.deepEqual(validateSelection('macbook', providers, { instanceId: 'grok', model: 'grok-build' }), { instanceId: 'grok', model: 'grok-build' });

    const refused: [ModelSelection, RegExp][] = [
      [{ instanceId: 'codex', model: 'claude-opus-5-5' }, /does not advertise model "claude-opus-5-5"/],
      [{ instanceId: 'claudeAgent', model: 'missing-model' }, /does not advertise model "missing-model"/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'nope' } }, /takes one of "low", "medium", "high"/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: true } }, /takes one of "low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink", not true/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { fastMode: 'yes' } }, /is a boolean; pass true or false, not "yes"/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { reasoningEffort: 'high' } }, /not a selectable option/],
      [{ instanceId: 'grok', model: 'grok-build', options: { effort: 'high' } }, /no selectable options/],
    ];
    for (const [selection, pattern] of refused) {
      const error = selectionError(providers, selection);
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.message, pattern);
    }
  });

  test('one odd option entry is left out and the rest of the catalog remains selectable', () => {
    const providers = catalogFrom([
      {
        providerInstanceId: 'mixed',
        driverKind: 'mixed',
        displayName: 'Mixed',
        models: [
          {
            id: 'both-shapes',
            label: 'Both',
            options: [
              null,
              'nope',
              { id: 'broken' },
              { id: '', values: ['x'] },
              { values: ['low', 'high'] },
              { id: 'numbers', values: [1, 2, 3] },
              { id: 'mixed', values: ['low', true] },
              { id: 'empty', values: [] },
              { id: 'blank', values: [''] },
              { id: 'effort', values: ['low', 'low', 'high'], default: 'low' },
              { id: 'effort-off-default', values: ['low', 'high'], default: 'medium' },
              { id: 'fastMode', values: [false, true] },
              { id: 'flag', values: [false], default: false },
              { id: 'flag-text-default', values: [true, false], default: 'yes' },
              {
                id: 'legacy-effort',
                label: 'Legacy effort',
                description: 'Descriptor shape',
                type: 'select',
                values: ['ignored-because-this-is-a-descriptor'],
                options: [
                  { id: 'low', label: 'Low' },
                  { id: 'bad-choice' },
                  { note: true },
                  { id: 'high', label: 'High', description: 'Thorough', isDefault: true },
                ],
                currentValue: 'low',
              },
              { id: 'legacy-fast', label: 'Legacy fast', type: 'boolean', currentValue: false },
              { id: 'legacy-slider', label: 'Slider', type: 'slider', currentValue: 3 },
            ],
          },
          { id: 'options-missing' },
          { id: 'options-null', options: null },
          { id: 'options-not-array', label: 'Still listed', options: { id: 'effort', values: ['low'] } },
        ],
      },
    ]);
    const both = model(providers, 'mixed', 'both-shapes');
    assert.deepEqual(both.options.map((entry) => entry.id), [
      'effort', 'effort-off-default', 'fastMode', 'flag', 'flag-text-default', 'legacy-effort', 'legacy-fast', 'legacy-slider',
    ]);
    assert.deepEqual(option(both.options, 'effort').choices?.map((choice) => [choice.id, choice.isDefault]), [['low', true], ['high', false]]);
    assert.equal(option(both.options, 'effort').currentValue, null);
    assert.deepEqual(option(both.options, 'effort-off-default').choices?.map((choice) => choice.isDefault), [false, false]);
    assert.deepEqual(option(both.options, 'fastMode'), { id: 'fastMode', label: 'fastMode', description: null, type: 'boolean', choices: null, currentValue: null });
    assert.equal(option(both.options, 'flag').currentValue, false);
    assert.equal(option(both.options, 'flag-text-default').currentValue, null);
    const legacy = option(both.options, 'legacy-effort');
    assert.equal(legacy.label, 'Legacy effort');
    assert.equal(legacy.description, 'Descriptor shape');
    assert.equal(legacy.currentValue, 'low');
    assert.deepEqual(legacy.choices, [
      { id: 'low', label: 'Low', description: null, isDefault: false },
      { id: 'high', label: 'High', description: 'Thorough', isDefault: true },
    ]);
    assert.equal(option(both.options, 'legacy-fast').currentValue, false);
    assert.deepEqual(option(both.options, 'legacy-slider'), { id: 'legacy-slider', label: 'Slider', description: null, type: 'slider', choices: null, currentValue: null });
    assert.deepEqual(model(providers, 'mixed', 'options-missing').options, []);
    assert.deepEqual(model(providers, 'mixed', 'options-null').options, []);
    assert.equal(model(providers, 'mixed', 'options-not-array').label, 'Still listed');
    assert.deepEqual(model(providers, 'mixed', 'options-not-array').options, []);

    assert.equal(selectionError(providers, { instanceId: 'mixed', model: 'both-shapes', options: { numbers: '1' } }).code, 'invalid_argument');
    assert.deepEqual(
      validateSelection('macbook', providers, { instanceId: 'mixed', model: 'both-shapes', options: { effort: 'high', flag: false, 'legacy-effort': 'high' } }),
      { instanceId: 'mixed', model: 'both-shapes', options: { effort: 'high', flag: false, 'legacy-effort': 'high' } },
    );
    assert.match(selectionError(providers, { instanceId: 'mixed', model: 'both-shapes', options: { 'legacy-slider': 'x' } }).message, /not a selectable option/);

    assert.throws(() => capabilitiesSchema.parse({ providers: [{ providerInstanceId: 'p', driverKind: 'd', models: [{ options: [] }] }] }), /id/);
    assert.throws(() => capabilitiesSchema.parse({ providers: [{ providerInstanceId: 'p', driverKind: 'd' }] }), /models/);
  });
});

interface ModelView {
  providerInstanceId: string;
  modelId: string;
  modelLabel: string | null;
  options: { id: string; label: string; type: string; choices: { id: string; isDefault: boolean }[] | null; currentValue: string | boolean | null }[];
}

async function toolText(agent: Agent, name: string, args: Record<string, unknown> = {}) {
  const result = await agent.client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((block) => block.text).join('\n');
  assert.notEqual(result.isError, true, text);
  return { structured: result.structuredContent as { hosts: { available: boolean; error: { code: string } | null; total: number | null; nextCursor: string | null; providers: { providerInstanceId: string; modelCount: number }[]; models: ModelView[] }[] }, text };
}

describe('model options through fleet_models and work_start', () => {
  test('a nightly catalog with one odd entry still lists both shapes, and work_start checks the selection', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    const providers = structuredClone(captured) as Record<string, unknown>[];
    const claude = providers.find((provider) => provider.providerInstanceId === 'claudeAgent') as { models: { id: string; options?: unknown[] }[] };
    const opus = claude.models.find((entry) => entry.id === 'claude-opus-5-5')!;
    opus.options = [...(opus.options ?? []), { id: 'broken-entry' }, { id: 'numbers', values: [1, 2] }, null];
    providers.push({
      providerInstanceId: 'legacy-provider',
      driverKind: 'legacy',
      displayName: 'Legacy descriptors',
      models: [{
        id: 'legacy-model',
        label: 'Legacy model',
        options: [
          {
            id: 'legacy-effort',
            label: 'Legacy effort',
            description: 'Descriptor shape',
            type: 'select',
            options: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High', isDefault: true },
            ],
            currentValue: 'low',
          },
          { id: 'legacy-fast', label: 'Legacy fast', type: 'boolean', currentValue: true },
          { id: 'legacy-slider', label: 'Slider', type: 'slider' },
        ],
      }],
    });
    fake.providers = providers as unknown as FakeProvider[];

    const { agent, gw, tick } = await startJobHarness(t, {
      fake,
      maxConcurrentJobs: 4,
      host: { discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' } },
    });
    const listed = await toolText(agent, 'fleet_models', { host: 'main', refresh: true });
    const host = listed.structured.hosts[0]!;
    assert.equal(host.available, true);
    assert.equal(host.error, null);
    assert.equal(host.nextCursor, null);
    assert.equal(host.total, 24, '23 captured models plus the legacy model');
    assert.equal(host.providers.find((provider) => provider.providerInstanceId === 'cursor')?.modelCount, 0);
    assert.equal(host.providers.find((provider) => provider.providerInstanceId === 'legacy-provider')?.modelCount, 1);

    const nightly = host.models.find((entry) => entry.providerInstanceId === 'claudeAgent' && entry.modelId === 'claude-opus-5-5')!;
    assert.deepEqual(nightly.options.map((entry) => entry.id), ['effort', 'fastMode']);
    assert.match(listed.text, /instanceId "claudeAgent" model "claude-opus-5-5" "Claude Opus 5.5": options effort \(select: low, medium\*, high, xhigh, max, ultracode, ultrathink\); fastMode \(boolean\)/);
    assert.match(listed.text, /instanceId "codex" model "gpt-6.1-sol": options reasoningEffort \(select: low\*, medium, high, xhigh, max, ultra\); serviceTier \(select: default\*, priority\)/);
    assert.match(listed.text, /instanceId "grok" model "grok-build" "Grok Build": no options/);
    assert.match(listed.text, /provider "cursor" \(cursor, Cursor\): 0 model\(s\)/);
    const legacy = host.models.find((entry) => entry.modelId === 'legacy-model')!;
    assert.deepEqual(legacy.options.map((entry) => [entry.id, entry.type, entry.currentValue]), [
      ['legacy-effort', 'select', 'low'],
      ['legacy-fast', 'boolean', true],
      ['legacy-slider', 'slider', null],
    ]);
    assert.match(listed.text, /legacy-effort \(select: low, high\*; currently low\); legacy-fast \(boolean, currently true\); legacy-slider \(slider, not selectable\)/);

    const started = await agent.call<{ job: { model: { source: string; selection: Record<string, unknown> } } }>('work_start', {
      project: 'pilot', task: 'Synthetic compact model selection', requestId: 'compact-effort',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } },
    });
    assert.deepEqual(started.job.model, { source: 'explicit', selection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } } });
    const withFast = await agent.call<{ job: { jobId: string } }>('work_start', {
      project: 'pilot', task: 'Synthetic compact model selection', requestId: 'compact-fast',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { fastMode: false, effort: 'high' } },
    });
    const codex = await agent.call<{ job: { model: { selection: Record<string, unknown> } } }>('work_start', {
      project: 'pilot', task: 'Synthetic compact model selection', requestId: 'compact-codex',
      modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'high' } },
    });
    assert.deepEqual(codex.job.model.selection, { instanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'high' } });
    const legacyJob = await agent.call<{ job: { model: { selection: Record<string, unknown> } } }>('work_start', {
      project: 'pilot', task: 'Synthetic compact model selection', requestId: 'legacy-shape',
      modelSelection: { instanceId: 'legacy-provider', model: 'legacy-model', options: { 'legacy-effort': 'high', 'legacy-fast': false } },
    });
    assert.deepEqual(legacyJob.job.model.selection, { instanceId: 'legacy-provider', model: 'legacy-model', options: { 'legacy-effort': 'high', 'legacy-fast': false } });

    const refused: [Record<string, unknown>, RegExp][] = [
      [{ instanceId: 'codex', model: 'claude-opus-5-5', options: { effort: 'high' } }, /does not advertise model "claude-opus-5-5"/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'nope' } }, /not "nope"/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { fastMode: 'yes' } }, /pass true or false/],
      [{ instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { 'broken-entry': 'x' } }, /not a selectable option/],
      [{ instanceId: 'grok', model: 'grok-build', options: { effort: 'high' } }, /no selectable options/],
    ];
    for (const [index, [modelSelection, pattern]] of refused.entries()) {
      const error = await agent.callError('work_start', { project: 'pilot', task: 'Synthetic compact model selection', requestId: `bad-${index}`, modelSelection });
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.text, pattern);
    }

    await tick();
    const launched = fake.launches.map((launch) => launch.modelSelection);
    assert.deepEqual(launched, [
      { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } },
      { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high', fastMode: false } },
      { instanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'high' } },
      { instanceId: 'legacy-provider', model: 'legacy-model', options: { 'legacy-effort': 'high', 'legacy-fast': false } },
    ]);
    assert.equal(fake.launches.length, 4);
    assert.ok(withFast.job.jobId);
    assertNotLogged(gw, ['Personal2', 'ultrathink', 'reasoningEffort', 'Claude Opus', 'Synthetic compact model selection', 'broken-entry']);
  });
});
