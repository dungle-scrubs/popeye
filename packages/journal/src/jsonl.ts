/**
 * Owns the JSONL Journal adapter and recovery of one unacknowledged torn tail.
 * It exists so durable acknowledgement, file validation, and diagnostics stay behind the Journal seam.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect, Layer, Ref, Schema, TSemaphore } from "effect";

import {
  JournalDraftRejected,
  JournalError,
  type JournalFailure,
  JournalNotFound,
} from "./errors.js";
import { type CreatedSession, type DerivedSession, deriveSession, Journal } from "./journal.js";
import { createLineCodec, type LineCodec } from "./line-codec.js";
import {
  type Entry,
  type EntryDraft,
  EntryDraftSchema,
  type EntryId,
  EntryIdSchema,
  type JournalLine,
  JournalLineSchema,
  type Record,
  type RecordDraft,
  RecordDraftSchema,
  type RecordId,
  RecordIdSchema,
  type SessionId,
  SessionIdSchema,
  type SessionRootEntry,
} from "./shapes.js";

const JournalHeaderSchema = Schema.Struct({
  format: Schema.Literal("peye_journal"),
  sessionId: SessionIdSchema,
  type: Schema.Literal("journal_header"),
  version: Schema.Literal(1),
});

type JournalHeader = Schema.Schema.Type<typeof JournalHeaderSchema>;

const JournalFileLineSchema = Schema.Union(JournalHeaderSchema, JournalLineSchema);

type JournalFileLine = Schema.Schema.Type<typeof JournalFileLineSchema>;

export const JournalDiagnosticSchema = Schema.Struct({
  action: Schema.Literal("opened", "recovered_torn_tail", "rejected"),
  corruptionClass: Schema.optional(
    Schema.Literal(
      "dangling_leaf_reference",
      "invalid_record_sequence",
      "io_failure",
      "malformed_json",
      "migration_failed",
      "missing_migration",
      "schema_mismatch",
      "unsupported_version",
    ),
  ),
  detail: Schema.optional(Schema.String),
  file: Schema.String,
});

export type JournalDiagnostic = Schema.Schema.Type<typeof JournalDiagnosticSchema>;

export interface JsonlJournalOptions {
  readonly diagnosticSink?: (diagnostic: JournalDiagnostic) => Effect.Effect<void>;
}

interface SessionState extends DerivedSession {
  readonly semaphore: TSemaphore.TSemaphore;
}

interface JsonlJournalState {
  readonly sessions: ReadonlyMap<SessionId, SessionState>;
}

interface JsonlJournalBacking {
  readonly codec: LineCodec<JournalFileLine>;
  readonly diagnosticSink: (diagnostic: JournalDiagnostic) => Effect.Effect<void>;
  readonly directory: string;
}

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeEntryDraft = Schema.decodeUnknown(EntryDraftSchema, strict);
const decodeRecordDraft = Schema.decodeUnknown(RecordDraftSchema, strict);

const createId = (): string => randomBytes(12).toString("base64url");

const createEntryId = (): EntryId => EntryIdSchema.make(createId());

const createRecordId = (): RecordId => RecordIdSchema.make(createId());

const createSessionId = (): SessionId => SessionIdSchema.make(createId());

const missingSession = (sessionId: SessionId): JournalNotFound =>
  new JournalNotFound({ id: sessionId, what: "session" });

const rejectedDraft = (kind: string, cause: unknown): JournalDraftRejected =>
  new JournalDraftRejected({ cause, kind, reason: "invalid_payload" });

const fileFailure = (file: string, operation: string, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "io_failure",
    file,
    message: `Could not ${operation} journal file ${file}: ${String(cause)}`,
  });

const fileEffect = <TOutput>(
  file: string,
  operation: string,
  run: () => Promise<TOutput>,
): Effect.Effect<TOutput, JournalError> =>
  Effect.tryPromise({
    catch: (cause) => fileFailure(file, operation, cause),
    try: run,
  });

const defaultDiagnosticSink = (diagnostic: JournalDiagnostic): Effect.Effect<void> => {
  const detail = JSON.stringify(diagnostic);
  return diagnostic.action === "rejected" ? Effect.logWarning(detail) : Effect.logInfo(detail);
};

const emitDiagnostic = (
  backing: JsonlJournalBacking,
  diagnostic: JournalDiagnostic,
): Effect.Effect<void> => backing.diagnosticSink(diagnostic);

const sessionFile = (directory: string, sessionId: SessionId): string =>
  join(directory, `${sessionId}.jsonl`);

const createCodec = (): Effect.Effect<LineCodec<JournalFileLine>, JournalError> =>
  createLineCodec({
    currentVersion: 1,
    versions: [{ payloadSchema: JournalFileLineSchema, version: 1 }],
  });

const closeIgnoringFailure = (handle: Awaited<ReturnType<typeof open>>): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: () => undefined,
    try: () => handle.close(),
  }).pipe(Effect.ignore);

const writeAndSync = (
  file: string,
  text: string,
  flags: "a" | "w" | "wx",
): Effect.Effect<void, JournalError> =>
  Effect.acquireUseRelease(
    fileEffect(file, "open", () => open(file, flags)),
    (handle) =>
      Effect.gen(function* () {
        yield* fileEffect(file, "write", () => handle.writeFile(text));
        yield* fileEffect(file, "sync", () => handle.sync());
      }),
    closeIgnoringFailure,
  );

const atomicallyRewrite = (file: string, text: string): Effect.Effect<void, JournalError> => {
  const temporary = `${file}.${createId()}.tmp`;
  return Effect.gen(function* () {
    yield* writeAndSync(temporary, text, "wx");
    yield* fileEffect(file, "replace", () => rename(temporary, file));
  });
};

const encodeFileLine = (
  backing: JsonlJournalBacking,
  file: string,
  line: JournalFileLine,
): Effect.Effect<string, JournalError> => backing.codec.encodeLine(line, { file });

const appendFileLine = (
  backing: JsonlJournalBacking,
  file: string,
  line: JournalFileLine,
): Effect.Effect<void, JournalError> =>
  Effect.gen(function* () {
    const encoded = yield* encodeFileLine(backing, file, line);
    // Acknowledgement gates recovery: only an fsync-confirmed line is preserved after a crash.
    yield* writeAndSync(file, `${encoded}\n`, "a");
  });

const invalidSequence = (file: string, detail: string): JournalError =>
  new JournalError({ corruptionClass: "invalid_record_sequence", file, message: detail });

const linesFrom = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
};

const decodeStoredLines = (
  backing: JsonlJournalBacking,
  file: string,
  text: string,
): Effect.Effect<
  { readonly lines: ReadonlyArray<JournalLine>; readonly recovered: boolean },
  JournalError
> =>
  Effect.gen(function* () {
    const physicalLines = linesFrom(text);
    const decoded: Array<JournalFileLine> = [];
    let recovered = false;

    for (let index = 0; index < physicalLines.length; index += 1) {
      const physicalLine = physicalLines[index];
      if (physicalLine === undefined) {
        continue;
      }
      const decodedLine = yield* backing.codec
        .decodeLine(physicalLine, { file, line: index + 1 })
        .pipe(
          Effect.catchTag("JournalError", (error) => {
            const isFinalLine = index === physicalLines.length - 1;
            if (!text.endsWith("\n") && isFinalLine && error.corruptionClass === "malformed_json") {
              return Effect.succeed(undefined);
            }
            return Effect.fail(error);
          }),
        );
      if (decodedLine === undefined) {
        const prefixEnd = text.lastIndexOf("\n");
        const prefix = prefixEnd < 0 ? "" : text.slice(0, prefixEnd + 1);
        yield* atomicallyRewrite(file, prefix);
        yield* emitDiagnostic(backing, {
          action: "recovered_torn_tail",
          detail: `Discarded partial line ${index + 1}.`,
          file,
        });
        recovered = true;
        break;
      }
      decoded.push(decodedLine);
    }

    const header = decoded[0];
    if (header === undefined || header.type !== "journal_header") {
      return yield* Effect.fail(
        invalidSequence(file, "A journal file must begin with its header."),
      );
    }
    const fileSessionId = basename(file, ".jsonl");
    if (header.sessionId !== fileSessionId) {
      return yield* Effect.fail(
        invalidSequence(file, "The journal header does not match its file name."),
      );
    }
    const lines = decoded.slice(1);
    if (lines.some((line) => line.type === "journal_header")) {
      return yield* Effect.fail(invalidSequence(file, "A journal header may occur only once."));
    }
    if (lines.some((line) => line.sessionId !== header.sessionId)) {
      return yield* Effect.fail(
        invalidSequence(file, "Every journal line must name the session in its header."),
      );
    }
    return { lines: lines as ReadonlyArray<JournalLine>, recovered };
  });

const openSession = (
  backing: JsonlJournalBacking,
  file: string,
): Effect.Effect<readonly [SessionId, SessionState], JournalError> =>
  Effect.gen(function* () {
    const text = yield* fileEffect(file, "read", () => readFile(file, "utf8"));
    const decoded = yield* decodeStoredLines(backing, file, text);
    const session = yield* deriveSession(decoded.lines).pipe(
      Effect.mapError(
        (error) =>
          new JournalError({
            cause: error.cause,
            corruptionClass: error.corruptionClass,
            file,
            message: error.message,
          }),
      ),
    );
    if (session === undefined) {
      return yield* Effect.fail(
        invalidSequence(file, "A journal file must contain a session_root entry."),
      );
    }
    const id = SessionIdSchema.make(basename(file, ".jsonl"));
    if (!decoded.recovered) {
      yield* emitDiagnostic(backing, { action: "opened", file });
    }
    return [id, { ...session, semaphore: TSemaphore.unsafeMake(1) }] as const;
  });

const openJournalState = (
  backing: JsonlJournalBacking,
): Effect.Effect<JsonlJournalState, JournalError> =>
  Effect.gen(function* () {
    yield* fileEffect(backing.directory, "create directory", () =>
      mkdir(backing.directory, { recursive: true }),
    );
    const names = yield* fileEffect(backing.directory, "list directory", () =>
      readdir(backing.directory),
    );
    const files = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(backing.directory, name));
    const opened = yield* Effect.all(
      files.map((file) => openSession(backing, file)),
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.catchTag("JournalError", (error) =>
        emitDiagnostic(backing, {
          action: "rejected",
          corruptionClass: error.corruptionClass,
          detail: error.message,
          file: error.file ?? backing.directory,
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    return { sessions: new Map(opened) };
  });

const updateSession = (
  stateRef: Ref.Ref<JsonlJournalState>,
  sessionId: SessionId,
  update: (session: SessionState) => SessionState,
): Effect.Effect<void> =>
  Ref.update(stateRef, (state) => {
    const previous = state.sessions.get(sessionId);
    if (previous === undefined) {
      return state;
    }
    const sessions = new Map(state.sessions);
    sessions.set(sessionId, update(previous));
    return { sessions };
  });

const withSession = <TOutput>(
  stateRef: Ref.Ref<JsonlJournalState>,
  sessionId: SessionId,
  operation: (session: SessionState) => Effect.Effect<TOutput, JournalFailure>,
): Effect.Effect<TOutput, JournalFailure> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const initial = state.sessions.get(sessionId);
    if (initial === undefined) {
      return yield* Effect.fail(missingSession(sessionId));
    }
    // The critical section includes file I/O so concurrent writers cannot choose the same parent leaf.
    return yield* Effect.gen(function* () {
      const current = (yield* Ref.get(stateRef)).sessions.get(sessionId);
      if (current === undefined) {
        return yield* Effect.fail(missingSession(sessionId));
      }
      return yield* operation(current);
    }).pipe(TSemaphore.withPermit(initial.semaphore));
  });

const createJournalJsonl = (
  backing: JsonlJournalBacking,
  stateRef: Ref.Ref<JsonlJournalState>,
) => ({
  appendEntry: (sessionId: SessionId, input: EntryDraft) =>
    withSession(stateRef, sessionId, (session) =>
      Effect.gen(function* () {
        const entry = yield* decodeEntryDraft(input).pipe(
          Effect.mapError((cause) => rejectedDraft(input.kind, cause)),
        );
        if (entry.kind === "session_root") {
          return yield* Effect.fail(
            new JournalDraftRejected({ kind: entry.kind, reason: "reserved_kind" }),
          );
        }
        const appended: Entry = {
          id: createEntryId(),
          kind: entry.kind,
          parentId: session.leaf.id,
          payload: entry.payload,
        };
        yield* appendFileLine(backing, sessionFile(backing.directory, sessionId), {
          item: appended,
          sessionId,
          type: "entry",
        });
        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          entries: new Map([...current.entries, [appended.id, appended]]),
          leaf: appended,
        }));
        return appended;
      }),
    ),
  appendRecord: (sessionId: SessionId, input: RecordDraft) =>
    withSession(stateRef, sessionId, (_session) =>
      Effect.gen(function* () {
        const record = yield* decodeRecordDraft(input).pipe(
          Effect.mapError((cause) => rejectedDraft(input.kind, cause)),
        );
        if (record.kind === "leaf_moved") {
          return yield* Effect.fail(
            new JournalDraftRejected({ kind: record.kind, reason: "reserved_kind" }),
          );
        }
        const appended: Record = {
          id: createRecordId(),
          kind: record.kind,
          payload: record.payload,
        };
        yield* appendFileLine(backing, sessionFile(backing.directory, sessionId), {
          item: appended,
          sessionId,
          type: "record",
        });
        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          records: [...current.records, appended],
        }));
        return appended;
      }),
    ),
  createSession: () =>
    Effect.gen(function* () {
      const id = createSessionId();
      const rootEntry: SessionRootEntry = {
        id: createEntryId(),
        kind: "session_root",
        parentId: null,
        payload: {},
      };
      const file = sessionFile(backing.directory, id);
      const header: JournalHeader = {
        format: "peye_journal",
        sessionId: id,
        type: "journal_header",
        version: 1,
      };
      const encodedHeader = yield* encodeFileLine(backing, file, header);
      const encodedRoot = yield* encodeFileLine(backing, file, {
        item: rootEntry,
        sessionId: id,
        type: "entry",
      });
      yield* atomicallyRewrite(file, `${encodedHeader}\n${encodedRoot}\n`);
      const initial: SessionState = {
        entries: new Map([[rootEntry.id, rootEntry]]),
        leaf: rootEntry,
        records: [],
        rootEntry,
        semaphore: TSemaphore.unsafeMake(1),
      };
      yield* Ref.update(stateRef, (state) => ({
        sessions: new Map([...state.sessions, [id, initial]]),
      }));
      yield* emitDiagnostic(backing, { action: "opened", file });
      return { id, rootEntry };
    }),
  getLeaf: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => Effect.succeed(session.leaf)),
  listSessions: () =>
    Ref.get(stateRef).pipe(
      Effect.map((state) =>
        Array.from(
          state.sessions,
          ([id, session]): CreatedSession => ({ id, rootEntry: session.rootEntry }),
        ),
      ),
    ),
  moveLeaf: (sessionId: SessionId, toEntryId: EntryId) =>
    withSession(stateRef, sessionId, (session) =>
      Effect.gen(function* () {
        if (!session.entries.has(toEntryId)) {
          return yield* Effect.fail(new JournalNotFound({ id: toEntryId, what: "entry" }));
        }
        const record: Record = {
          id: createRecordId(),
          kind: "leaf_moved",
          payload: { toEntryId },
        };
        yield* appendFileLine(backing, sessionFile(backing.directory, sessionId), {
          item: record,
          sessionId,
          type: "record",
        });
        const leaf = session.entries.get(toEntryId);
        if (leaf === undefined) {
          return yield* Effect.die("Session entry vanished while its semaphore was held.");
        }
        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          leaf,
          records: [...current.records, record],
        }));
        return record;
      }),
    ),
  readBranch: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => {
      const branch: Array<Entry> = [];
      let entry: Entry | undefined = session.leaf;
      while (entry !== undefined) {
        branch.push(entry);
        entry = entry.parentId === null ? undefined : session.entries.get(entry.parentId);
      }
      return Effect.succeed(branch.reverse());
    }),
  readRecords: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => Effect.succeed(session.records)),
});

export const JournalJsonl = (
  directory: string,
  options: JsonlJournalOptions = {},
): Layer.Layer<Journal, JournalError> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const backing: JsonlJournalBacking = {
        codec: yield* createCodec(),
        diagnosticSink: options.diagnosticSink ?? defaultDiagnosticSink,
        directory,
      };
      const state = yield* openJournalState(backing);
      const stateRef = yield* Ref.make(state);
      return createJournalJsonl(backing, stateRef);
    }),
  );

export const createJsonlJournalHarness = (directory: string) => ({
  layer: JournalJsonl(directory),
  reopen: () => JournalJsonl(directory),
  snapshotLines: (): Effect.Effect<ReadonlyArray<unknown>> =>
    fileEffect(directory, "list directory", () => readdir(directory)).pipe(
      Effect.flatMap((names) =>
        Effect.all(
          names
            .filter((name) => name.endsWith(".jsonl"))
            .sort()
            .map((name) =>
              fileEffect(join(directory, name), "read", () =>
                readFile(join(directory, name), "utf8"),
              ),
            ),
        ),
      ),
      Effect.map((files) => files.flatMap((file) => linesFrom(file))),
      Effect.orDie,
    ),
});
