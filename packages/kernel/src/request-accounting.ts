import type { Record as JournalRecord, SessionId } from "@dungle-scrubs/popeye-journal";
import { Schema } from "effect";

const CountSchema = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("unknown"),
    reason: Schema.Literal("absent", "ambiguous_zero", "invalid"),
  }),
  Schema.Struct({
    status: Schema.Literal("normalized"),
    value: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    mapping: Schema.Literal("pi-ai@0.84.1"),
  }),
);

export type AccountingCount = Schema.Schema.Type<typeof CountSchema>;

const CountsSchema = Schema.Struct({
  input: CountSchema,
  output: CountSchema,
  cacheRead: CountSchema,
  cacheWrite: CountSchema,
  cacheWrite1h: CountSchema,
  reasoning: CountSchema,
});

export type AccountingCounts = Schema.Schema.Type<typeof CountsSchema>;

const CommonSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  requestId: Schema.String,
  ownerId: Schema.String,
  purpose: Schema.Literal("turn", "compaction"),
  attempt: Schema.Number.pipe(Schema.int(), Schema.positive()),
  provider: Schema.String,
  model: Schema.String,
  startedAt: Schema.String,
});

export const RequestStartedSchema = Schema.Struct({ ...CommonSchema.fields });
export type RequestStarted = Schema.Schema.Type<typeof RequestStartedSchema>;

export const RequestUsageSchema = Schema.Struct({
  ...CommonSchema.fields,
  completedAt: Schema.String,
  outcome: Schema.Literal("done", "error", "aborted", "incomplete"),
  counts: CountsSchema,
  attemptGranularity: Schema.Literal("provider-invocation"),
});
export type RequestUsage = Schema.Schema.Type<typeof RequestUsageSchema>;

const strict = { onExcessProperty: "error" } as const;
const decodeStart = Schema.decodeUnknownSync(RequestStartedSchema, strict);
const decodeUsage = Schema.decodeUnknownSync(RequestUsageSchema, strict);

const count = (value: unknown): AccountingCount =>
  value === undefined
    ? { status: "unknown", reason: "absent" }
    : typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      ? { status: "unknown", reason: "invalid" }
      : value === 0
        ? { status: "unknown", reason: "ambiguous_zero" }
        : { status: "normalized", value, mapping: "pi-ai@0.84.1" };

export const countsFromPiAi = (usage: unknown): AccountingCounts => {
  if (typeof usage !== "object" || usage === null) {
    const missing: AccountingCount = { status: "unknown", reason: "absent" };
    return {
      input: missing,
      output: missing,
      cacheRead: missing,
      cacheWrite: missing,
      cacheWrite1h: missing,
      reasoning: missing,
    };
  }
  const source = usage as Record<string, unknown>;
  return {
    input: count(source.input),
    output: count(source.output),
    cacheRead: count(source.cacheRead),
    cacheWrite: count(source.cacheWrite),
    cacheWrite1h: count(source.cacheWrite1h),
    reasoning: count(source.reasoning),
  };
};

export type ExportRow =
  | RequestUsage
  | (RequestStarted & {
      readonly outcome: "pending";
      readonly counts: AccountingCounts;
      readonly completedAt: null;
      readonly attemptGranularity: "provider-invocation";
    });

/** All branches count. A terminal receipt replaces its matching start; duplicate terminals fail closed. */
export const accountingRows = (
  sessionId: SessionId,
  records: ReadonlyArray<JournalRecord>,
): ReadonlyArray<ExportRow> => {
  const starts = new Map<string, RequestStarted>();
  const finals = new Map<string, RequestUsage>();
  for (const record of records) {
    if (record.kind === "provider_request_started") {
      const start = decodeStart(record.payload);
      if (start.sessionId !== sessionId || starts.has(start.requestId))
        throw new Error("ACCOUNTING_INTEGRITY");
      starts.set(start.requestId, start);
    } else if (record.kind === "provider_request_usage") {
      const usage = decodeUsage(record.payload);
      if (usage.sessionId !== sessionId || finals.has(usage.requestId))
        throw new Error("ACCOUNTING_INTEGRITY");
      finals.set(usage.requestId, usage);
    }
  }
  for (const [requestId, usage] of finals) {
    const start = starts.get(requestId);
    if (
      start === undefined ||
      Object.keys(start).some(
        (key) =>
          (start as Record<string, unknown>)[key] !== (usage as Record<string, unknown>)[key],
      )
    )
      throw new Error("ACCOUNTING_INTEGRITY");
  }
  return [...starts.values()].map(
    (start) =>
      finals.get(start.requestId) ?? {
        ...start,
        outcome: "pending" as const,
        completedAt: null,
        counts: countsFromPiAi(undefined),
        attemptGranularity: "provider-invocation" as const,
      },
  );
};
