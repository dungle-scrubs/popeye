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
  Schema.Struct({
    status: Schema.Literal("estimated"),
    value: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    mapping: Schema.Literal("pi-ai-faux@0.84.1"),
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

const SessionIdentitySchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{16}$/u));
const RequestIdentitySchema = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
);
const IdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$/u),
);
const TimestampSchema = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.filter(
    (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
  ),
);

const CommonSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: SessionIdentitySchema,
  requestId: RequestIdentitySchema,
  ownerId: RequestIdentitySchema,
  purpose: Schema.Literal("turn", "compaction"),
  attempt: Schema.Number.pipe(Schema.int(), Schema.positive()),
  provider: IdentifierSchema,
  providerClass: Schema.Literal("hosted", "local", "unknown"),
  model: IdentifierSchema,
  startedAt: TimestampSchema,
});

export const RequestStartedSchema = Schema.Struct({ ...CommonSchema.fields });
export type RequestStarted = Schema.Schema.Type<typeof RequestStartedSchema>;

export const RequestUsageSchema = Schema.Struct({
  ...CommonSchema.fields,
  completedAt: TimestampSchema,
  outcome: Schema.Literal("done", "error", "aborted", "incomplete"),
  counts: CountsSchema,
  attemptGranularity: Schema.Literal("provider-invocation"),
});
export type RequestUsage = Schema.Schema.Type<typeof RequestUsageSchema>;

const strict = { onExcessProperty: "error" } as const;
const decodeStart = Schema.decodeUnknownSync(RequestStartedSchema, strict);
const decodeUsage = Schema.decodeUnknownSync(RequestUsageSchema, strict);

const count = (value: unknown, provenance: "normalized" | "estimated"): AccountingCount =>
  value === undefined
    ? { status: "unknown", reason: "absent" }
    : typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      ? { status: "unknown", reason: "invalid" }
      : value === 0
        ? { status: "unknown", reason: "ambiguous_zero" }
        : provenance === "estimated"
          ? { status: "estimated", value, mapping: "pi-ai-faux@0.84.1" }
          : { status: "normalized", value, mapping: "pi-ai@0.84.1" };

export const countsFromPiAi = (
  usage: unknown,
  provenance: "normalized" | "estimated" = "normalized",
): AccountingCounts => {
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
    input: count(source.input, provenance),
    output: count(source.output, provenance),
    cacheRead: count(source.cacheRead, provenance),
    cacheWrite: count(source.cacheWrite, provenance),
    cacheWrite1h: count(source.cacheWrite1h, provenance),
    reasoning: count(source.reasoning, provenance),
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
