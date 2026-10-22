import * as z from 'zod';

/** The fields of `t3_environment_read` the gateway relies on. Extra fields are kept, not validated. */
export const environmentSchema = z.looseObject({
  environmentId: z.string(),
  serverVersion: z.string(),
  platform: z.looseObject({ os: z.string(), arch: z.string() }),
});
export type T3Environment = z.infer<typeof environmentSchema>;

export const projectSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  deletedAt: z.string().nullable().optional(),
  /** The model T3 uses for a launch that passes no `modelSelection`; without one, such a launch is refused. */
  defaultModelSelection: z.unknown().optional(),
});
export type T3Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({
  projects: z.array(projectSchema),
  nextCursor: z.number().int().nullable().optional(),
});

/**
 * One model option after recognition, in the descriptor shape the rest of the gateway already uses.
 * `type` stays a plain string so a kind this gateway cannot select is listed, not a catalog failure.
 * `select` carries `options` (the choices); `boolean` uses `currentValue` when T3 reports one.
 */
export const optionDescriptorSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().nullish(),
  type: z.string(),
  options: z
    .array(z.looseObject({ id: z.string().min(1), label: z.string(), description: z.string().nullish(), isDefault: z.boolean().nullish() }))
    .nullish(),
  currentValue: z.union([z.string(), z.boolean()]).nullish(),
});
export type OptionDescriptor = z.infer<typeof optionDescriptorSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A descriptor-shaped choice. An entry without a usable id and label is omitted; the option stays.
 * `isDefault` is only kept when T3 actually sent `true` (a missing flag is not a default).
 */
function normalizeChoice(value: unknown): { id: string; label: string; description: string | null; isDefault: boolean } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.label !== 'string') return undefined;
  return {
    id: value.id,
    label: value.label,
    description: typeof value.description === 'string' ? value.description : null,
    isDefault: value.isDefault === true,
  };
}

/**
 * Older T3: `{ id, label, type, description?, options?: [{ id, label, description?, isDefault? }], currentValue? }`.
 * A choice that is not that shape is dropped. `currentValue` is kept only when it is a string or boolean,
 * so `false` survives and a non-scalar does not reject the option.
 */
function normalizeDescriptor(value: Record<string, unknown>): OptionDescriptor {
  const choices = Array.isArray(value.options) ? value.options.flatMap((entry) => {
    const choice = normalizeChoice(entry);
    return choice ? [choice] : [];
  }) : [];
  const current = value.currentValue;
  return {
    id: value.id as string,
    label: value.label as string,
    description: typeof value.description === 'string' ? value.description : null,
    type: value.type as string,
    options: choices,
    currentValue: typeof current === 'string' || typeof current === 'boolean' ? current : null,
  };
}

/**
 * Current T3 nightlies: `{ id, values, default? }`. Every value a boolean means a boolean option
 * (`default` is the current value when it is a boolean; `values` recognizes the type and is not an
 * allowlist). Every value a non-empty string means a select option; the choices are those strings in
 * order, duplicates removed, and `default` marks a choice when it is one of them. A mixed or empty
 * list is not a recognized option.
 */
function normalizeCompact(value: Record<string, unknown>): OptionDescriptor | undefined {
  if (typeof value.id !== 'string' || value.id.length === 0 || !Array.isArray(value.values) || value.values.length === 0) return undefined;
  const label = typeof value.label === 'string' ? value.label : value.id;
  const description = typeof value.description === 'string' ? value.description : null;
  if (value.values.every((entry) => typeof entry === 'boolean')) {
    return {
      id: value.id,
      label,
      description,
      type: 'boolean',
      options: null,
      currentValue: typeof value.default === 'boolean' ? value.default : null,
    };
  }
  if (!value.values.every((entry) => typeof entry === 'string' && entry.length > 0)) return undefined;
  const seen = new Set<string>();
  const options = [];
  for (const entry of value.values) {
    if (typeof entry !== 'string' || seen.has(entry)) continue;
    seen.add(entry);
    options.push({ id: entry, label: entry, description: null, isDefault: value.default === entry });
  }
  return { id: value.id, label, description, type: 'select', options, currentValue: null };
}

/**
 * One advertised option, or nothing when the entry matches neither shape. Descriptor wins when `type`
 * and `label` are both strings, so an older payload is unchanged even if it also carries `values`.
 */
function normalizeAdvertisedOption(value: unknown): OptionDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const descriptor = typeof value.id === 'string' && value.id.length > 0
    && typeof value.type === 'string' && value.type.length > 0
    && typeof value.label === 'string';
  return descriptor ? normalizeDescriptor(value) : normalizeCompact(value);
}

/** Keep recognized options, in order. A missing or non-array `options` field is no options, not a catalog failure. */
function normalizeAdvertisedOptions(value: unknown): OptionDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = normalizeAdvertisedOption(entry);
    return option ? [option] : [];
  });
}

/** The fields of `orchestrator_capabilities` the gateway relies on; T3's result has more (features, inherited model). */
export const capabilitiesSchema = z.looseObject({
  providers: z.array(
    z.looseObject({
      providerInstanceId: z.string().min(1),
      driverKind: z.string(),
      displayName: z.string().nullish(),
      models: z.array(z.looseObject({
        id: z.string().min(1),
        label: z.string().nullish(),
        /**
         * Each entry is normalized before the descriptor schema sees it. An entry that is neither the
         * descriptor shape nor the compact `{ id, values, default? }` shape is omitted, so one odd
         * option does not make the host's catalog `t3_invalid_response`.
         */
        options: z.preprocess(normalizeAdvertisedOptions, z.array(optionDescriptorSchema)).optional(),
      })),
      runtimeModes: z.array(z.string()).nullish(),
      /** Whether this provider may run a delegated child task inside T3: metadata, not proof that a top-level launch works. */
      canRunChildTask: z.boolean().nullish(),
      canRunCrossProviderChildTask: z.boolean().nullish(),
      constraints: z.array(z.string()).nullish(),
    }),
  ),
});
export type T3Capabilities = z.infer<typeof capabilitiesSchema>;
export type T3ProviderCapability = T3Capabilities['providers'][number];

/**
 * Thread and run status values T3 documents. Outputs are parsed as plain strings so that a status
 * added by a newer T3 does not break watching; the job layer treats unrecognised values as active.
 */
export const THREAD_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** A run is still going (or about to) in these statuses. `waiting` means it is blocked on the user. */
export const ACTIVE_RUN_STATUSES: readonly string[] = ['preparing', 'queued', 'starting', 'running', 'waiting'];

export const RUNTIME_MODE_VALUES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;

/** Input of `t3_thread_launch` as the gateway sends it (a subset of what T3 accepts). */
export interface LaunchThreadInput {
  projectId: string;
  title: string;
  workspaceStrategy: { type: 'root' } | { type: 'worktree'; baseRef: string; branch: string; startFromOrigin: boolean };
  runtimeMode: (typeof RUNTIME_MODE_VALUES)[number];
  modelSelection?: Record<string, unknown>;
  message: string;
}

/** Current T3 omits links. Keep older supplied links and normalize newer responses at the boundary. */
function withThreadLink<T extends { threadId: string; link?: string | null }>(thread: T) {
  return { ...thread, link: thread.link ?? `t3-thread://v1/${thread.threadId}` };
}

export const launchResultSchema = z.looseObject({
  threadId: z.string().min(1),
  link: z.string().nullish(),
  projectId: z.string(),
  runId: z.string().nullable(),
  status: z.string().nullable(),
}).transform(withThreadLink);
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const threadSummarySchema = z.looseObject({
  threadId: z.string(),
  link: z.string().nullish(),
  title: z.string(),
  status: z.string(),
  latestRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).transform(withThreadLink);
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadListSchema = z.looseObject({
  projectId: z.string(),
  threads: z.array(threadSummarySchema),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
export type ThreadList = z.infer<typeof threadListSchema>;

export const threadSearchSchema = z.looseObject({
  matches: z.array(
    z.looseObject({
      threadId: z.string(),
      projectId: z.string(),
      source: z.string(),
      snippet: z.string(),
    }),
  ),
});
export type ThreadSearch = z.infer<typeof threadSearchSchema>;

export const threadItemSchema = z.looseObject({
  position: z.number().int(),
  itemId: z.string(),
  runId: z.string().nullable(),
  createdBy: z.string().nullable(),
  creationSource: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  updatedAt: z.string(),
  /** Set on some item types: a `subagent` item's title is the delegated task's title. */
  title: z.string().nullable().optional(),
});
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const threadRunSchema = z.looseObject({
  runId: z.string(),
  ordinal: z.number().int(),
  status: z.string(),
  completedAt: z.string().nullable(),
});
export type ThreadRun = z.infer<typeof threadRunSchema>;

export const threadReadSchema = z.looseObject({
  thread: z.looseObject({
    threadId: z.string(),
    link: z.string().nullish(),
    projectId: z.string(),
    title: z.string(),
    status: z.string(),
    latestRunId: z.string().nullable(),
    activeRunId: z.string().nullable(),
    pendingRequestCount: z.number().int(),
    branch: z.string().nullable(),
    /** T3 refuses messages to an archived thread. */
    archived: z.boolean().optional(),
    updatedAt: z.string(),
  }).transform(withThreadLink),
  recentRuns: z.array(threadRunSchema),
  items: z.array(threadItemSchema),
  nextPosition: z.number().int().nullable(),
  hasMore: z.boolean(),
});
export type ThreadRead = z.infer<typeof threadReadSchema>;

export const SEND_MODES = ['auto', 'queue', 'steer', 'restart'] as const;

export const sendResultSchema = z.looseObject({
  threadId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  status: z.string(),
  delivery: z.string(),
});
export type SendResult = z.infer<typeof sendResultSchema>;

export const interruptResultSchema = z.looseObject({
  threadId: z.string(),
  runId: z.string().nullable(),
  status: z.string(),
});
export type InterruptResult = z.infer<typeof interruptResultSchema>;

export const pendingRequestListSchema = z.looseObject({ requestIds: z.array(z.string()) });

export const pendingRequestSchema = z.looseObject({
  requestId: z.string(),
  questions: z.array(
    z.looseObject({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string(), value: z.string().nullable().optional() })),
      multiSelect: z.boolean().nullable().optional(),
      allowCustomAnswer: z.boolean().nullable().optional(),
      required: z.boolean().nullable().optional(),
    }),
  ).nullable(),
});
export type PendingRequest = z.infer<typeof pendingRequestSchema>;

export const respondResultSchema = z.looseObject({ sequence: z.number().int() });
