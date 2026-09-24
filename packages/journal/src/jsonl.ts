/**
 * Owns the JSONL Journal adapter and recovery of one unacknowledged torn tail.
 * It exists so durable acknowledgement, file validation, and diagnostics stay behind the Journal seam.
 * Private seam of JournalStore (C4 architecture review): this adapter is selected via
 * JournalStore.selectLayer, not directly by CLI; WAL vs torn-tail and diagnostics stay behind the store.
 *
 * This is a single-writer design: one in-process layer owns a journal directory at a time. The
 * kernel owns individual sessions, but cross-process locking is intentionally out of scope.
 */
import { randomBytes } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import {
  availableSession,
  createJournalAdapter,
  type JournalAdapterState,
  type JournalIoObservation,
  type JournalPersistence,
  rejectedSession,
} from "./adapter-core.js";
import { JournalError } from "./errors.js";
import {
  type DerivedSession,
  deriveSession,
  type ExportRead,
  Journal,
  type JournalHeader,
  JournalHeaderSchema,
} from "./journal.js";
import { createLineCodec, type LineCodec } from "./line-codec.js";
import { type JournalLine, JournalLineSchema, type SessionId, SessionIdSchema } from "./shapes.js";

const JournalFileLineSchema = Schema.Union(JournalHeaderSchema, JournalLineSchema);
type JournalFileLine = Schema.Schema.Type<typeof JournalFileLineSchema>;

export const JournalDiagnosticSchema = Schema.Struct({
  action: Schema.Literal("opened", "recovered_torn_tail", "rejected"),
  corruptionClass: Schema.optional(
    Schema.Literal(
      "dangling_leaf_reference",
      "invalid_compaction",
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

export interface JsonlIoEvent extends JournalIoObservation {
  readonly file: string;
}

export interface JsonlJournalIo {
  readonly observe?: (event: JsonlIoEvent) => Effect.Effect<void>;
  readonly sync?: (handle: FileHandle, file: string) => Promise<void>;
}

export interface JsonlJournalOptions {
  readonly diagnosticSink?: (diagnostic: JournalDiagnostic) => Effect.Effect<void>;
  readonly io?: JsonlJournalIo;
  /**
   * Suppresses torn-tail repair and temporary-file cleanup at open.
   * The export reader uses it so pre-torn tails report instead of healing.
   */
  readonly suppressRepair?: boolean;
}

interface JsonlJournalBacking {
  readonly codec: LineCodec<JournalFileLine>;
  readonly diagnosticSink: (diagnostic: JournalDiagnostic) => Effect.Effect<void>;
  readonly directory: string;
  readonly io: JsonlJournalIo;
  readonly suppressRepair: boolean;
}

interface LoadedSession {
  readonly derived: DerivedSession;
  readonly recovered: boolean;
}

const openDirectories = new Set<string>();
const createId = (): string => randomBytes(12).toString("base64url");

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

const emitIo = (backing: JsonlJournalBacking, event: JsonlIoEvent): Effect.Effect<void> =>
  backing.io.observe?.(event) ?? Effect.void;

const sessionFile = (directory: string, sessionId: SessionId): string =>
  join(directory, `${sessionId}.jsonl`);

const createCodec = (): Effect.Effect<LineCodec<JournalFileLine>, JournalError> =>
  createLineCodec({
    currentVersion: 1,
    versions: [{ payloadSchema: JournalFileLineSchema, version: 1 }],
  });

const closeIgnoringFailure = (handle: FileHandle): Effect.Effect<void> =>
  // A close failure cannot change the completed write or make its acknowledged bytes unsafe.
  Effect.ignore(Effect.tryPromise({ catch: () => undefined, try: () => handle.close() }));

const sync = (
  backing: JsonlJournalBacking,
  file: string,
  handle: FileHandle,
): Effect.Effect<void, JournalError> =>
  fileEffect(file, "sync", () => backing.io.sync?.(handle, file) ?? handle.sync());

const writeAndSync = (
  backing: JsonlJournalBacking,
  file: string,
  sessionId: SessionId,
  text: string,
  flags: "a" | "w" | "wx",
): Effect.Effect<void, JournalError> =>
  Effect.acquireUseRelease(
    fileEffect(file, "open", () => open(file, flags)),
    (handle) =>
      Effect.gen(function* () {
        yield* fileEffect(file, "write", () => handle.writeFile(text));
        yield* emitIo(backing, { file, operation: "write", sessionId });
        yield* sync(backing, file, handle);
        yield* emitIo(backing, { file, operation: "sync", sessionId });
      }),
    closeIgnoringFailure,
  );

const syncDirectory = (
  backing: JsonlJournalBacking,
  sessionId: SessionId,
): Effect.Effect<void, JournalError> =>
  Effect.acquireUseRelease(
    fileEffect(backing.directory, "open directory", () => open(backing.directory, "r")),
    (handle) =>
      Effect.gen(function* () {
        yield* sync(backing, backing.directory, handle);
        yield* emitIo(backing, { file: backing.directory, operation: "sync", sessionId });
      }),
    closeIgnoringFailure,
  );

const atomicallyRewrite = (
  backing: JsonlJournalBacking,
  file: string,
  sessionId: SessionId,
  text: string,
): Effect.Effect<void, JournalError> => {
  const temporary = `${file}.${createId()}.tmp`;
  return Effect.gen(function* () {
    yield* writeAndSync(backing, temporary, sessionId, text, "wx");
    yield* fileEffect(file, "replace", () => rename(temporary, file));
    // A rename or new directory entry is not durable until the directory inode is synced.
    yield* syncDirectory(backing, sessionId);
  }).pipe(Effect.uninterruptible);
};

const encodeFileLine = (
  backing: JsonlJournalBacking,
  file: string,
  line: JournalFileLine,
): Effect.Effect<string, JournalError> => backing.codec.encodeLine(line, { file });

const invalidSequence = (file: string, detail: string): JournalError =>
  new JournalError({ corruptionClass: "invalid_record_sequence", file, message: detail });

const linesFrom = (text: string): ReadonlyArray<string> =>
  text === "" ? [] : text.slice(0, -1).split("\n");

const acknowledgedPrefix = (
  text: string,
): { readonly recovered: boolean; readonly text: string } => {
  if (text.endsWith("\n")) {
    return { recovered: false, text };
  }
  const boundary = text.lastIndexOf("\n");
  // A completed append always ends in a newline, so an unterminated tail cannot be acknowledged content.
  return { recovered: true, text: boundary < 0 ? "" : text.slice(0, boundary + 1) };
};

const decodeStoredLines = (
  backing: JsonlJournalBacking,
  file: string,
  text: string,
): Effect.Effect<
  {
    readonly header: JournalHeader;
    readonly lines: ReadonlyArray<JournalLine>;
    readonly recovered: boolean;
  },
  JournalError
> =>
  Effect.gen(function* () {
    const prefix = acknowledgedPrefix(text);
    const decoded: Array<JournalFileLine> = [];
    for (const [index, physicalLine] of linesFrom(prefix.text).entries()) {
      decoded.push(yield* backing.codec.decodeLine(physicalLine, { file, line: index + 1 }));
    }
    const header = decoded[0];
    if (header === undefined || header.type !== "journal_header") {
      return yield* Effect.fail(
        invalidSequence(file, "A journal file must begin with its header."),
      );
    }
    if (header.sessionId !== basename(file, ".jsonl")) {
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
    return { header, lines: lines as ReadonlyArray<JournalLine>, recovered: prefix.recovered };
  });

const loadSession = (
  backing: JsonlJournalBacking,
  sessionId: SessionId,
): Effect.Effect<LoadedSession, JournalError> =>
  Effect.gen(function* () {
    const file = sessionFile(backing.directory, sessionId);
    const text = yield* fileEffect(file, "read", () => readFile(file, "utf8"));
    // Validate the entire surviving prefix before changing a byte. This prevents a torn tail from
    // concealing earlier acknowledged corruption.
    const decoded = yield* decodeStoredLines(backing, file, text);
    const derived = yield* deriveSession(decoded.lines).pipe(
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
    if (derived === undefined) {
      return yield* Effect.fail(
        invalidSequence(file, "A journal file must contain a session_root entry."),
      );
    }
    if (decoded.recovered && !backing.suppressRepair) {
      yield* atomicallyRewrite(backing, file, sessionId, acknowledgedPrefix(text).text);
      yield* emitDiagnostic(backing, {
        action: "recovered_torn_tail",
        detail: "Discarded an unterminated final line.",
        file,
      });
    }
    yield* emitDiagnostic(backing, { action: "opened", file });
    return { derived, recovered: decoded.recovered };
  });

const sweepTemporaryFiles = (backing: JsonlJournalBacking): Effect.Effect<void, JournalError> =>
  fileEffect(backing.directory, "list directory", () => readdir(backing.directory)).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => name.endsWith(".tmp")),
        (name) =>
          fileEffect(join(backing.directory, name), "remove temporary", () =>
            rm(join(backing.directory, name), { force: true }),
          ),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );

const openJournalState = (
  backing: JsonlJournalBacking,
): Effect.Effect<JournalAdapterState, JournalError> =>
  Effect.gen(function* () {
    if (!backing.suppressRepair) {
      yield* sweepTemporaryFiles(backing);
    }
    const names = yield* fileEffect(backing.directory, "list directory", () =>
      readdir(backing.directory),
    );
    const sessions = new Map<
      SessionId,
      ReturnType<typeof availableSession> | ReturnType<typeof rejectedSession>
    >();
    for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
      const id = SessionIdSchema.make(basename(name, ".jsonl"));
      const file = join(backing.directory, name);
      const result = yield* loadSession(backing, id).pipe(Effect.either);
      if (result._tag === "Right") {
        sessions.set(id, availableSession(result.right.derived));
      } else {
        const error = result.left;
        yield* emitDiagnostic(backing, {
          action: "rejected",
          corruptionClass: error.corruptionClass,
          detail: error.message,
          file: error.file ?? file,
        });
        sessions.set(id, rejectedSession(error));
      }
    }
    return { sessions };
  });

const jsonlPersistence = (backing: JsonlJournalBacking): JournalPersistence => ({
  initializeSession: (sessionId, rootEntry) =>
    Effect.gen(function* () {
      const file = sessionFile(backing.directory, sessionId);
      const header: JournalHeader = {
        format: "popeye_journal",
        sessionId,
        type: "journal_header",
        version: 1,
      };
      const encodedHeader = yield* encodeFileLine(backing, file, header);
      const encodedRoot = yield* encodeFileLine(backing, file, {
        item: rootEntry,
        sessionId,
        type: "entry",
      });
      yield* atomicallyRewrite(backing, file, sessionId, `${encodedHeader}\n${encodedRoot}\n`);
      yield* emitDiagnostic(backing, { action: "opened", file });
    }),
  loadSession: (sessionId) =>
    loadSession(backing, sessionId).pipe(Effect.map((loaded) => loaded.derived)),
  readExport: (sessionId) =>
    Effect.gen(function* () {
      const file = sessionFile(backing.directory, sessionId);
      // Report-only: decode the acknowledged prefix like a native open,
      // but never rewrite the file and never emit a recovery diagnostic.
      const text = yield* fileEffect(file, "read", () => readFile(file, "utf8"));
      const decoded = yield* decodeStoredLines(backing, file, text);
      const sizeBytes = yield* fileEffect(file, "stat", () => stat(file)).pipe(
        Effect.map((info) => info.size),
      );
      const exportRead: ExportRead = {
        header: decoded.header,
        incompleteTail: decoded.recovered,
        lines: decoded.lines,
        sizeBytes,
      };
      return exportRead;
    }),
  observe: ({ operation, sessionId }) =>
    emitIo(backing, { file: sessionFile(backing.directory, sessionId), operation, sessionId }),
  persistLine: (sessionId, line) =>
    Effect.gen(function* () {
      const file = sessionFile(backing.directory, sessionId);
      const encoded = yield* encodeFileLine(backing, file, line);
      yield* writeAndSync(backing, file, sessionId, `${encoded}\n`, "a");
    }),
});

const acquireBacking = (
  directory: string,
  options: JsonlJournalOptions,
): Effect.Effect<JsonlJournalBacking, JournalError> =>
  Effect.gen(function* () {
    yield* fileEffect(directory, "create directory", () => mkdir(directory, { recursive: true }));
    const codec = yield* createCodec();
    const canonicalDirectory = yield* fileEffect(directory, "canonicalize directory", () =>
      realpath(directory),
    );
    if (openDirectories.has(canonicalDirectory)) {
      return yield* Effect.fail(
        new JournalError({
          corruptionClass: "io_failure",
          file: canonicalDirectory,
          message: `Journal directory is already open in this process: ${canonicalDirectory}`,
        }),
      );
    }
    openDirectories.add(canonicalDirectory);
    return {
      codec,
      diagnosticSink: options.diagnosticSink ?? defaultDiagnosticSink,
      directory: canonicalDirectory,
      io: options.io ?? {},
      suppressRepair: options.suppressRepair ?? false,
    };
  });

export const JournalJsonl = (
  directory: string,
  options: JsonlJournalOptions = {},
): Layer.Layer<Journal, JournalError> =>
  Layer.scoped(
    Journal,
    Effect.gen(function* () {
      const backing = yield* Effect.acquireRelease(acquireBacking(directory, options), (acquired) =>
        Effect.sync(() => openDirectories.delete(acquired.directory)),
      );
      const state = yield* openJournalState(backing);
      return yield* createJournalAdapter(state, jsonlPersistence(backing));
    }),
  );

// Test-only helper. It stays module-private so production consumers cannot depend on test harnesses.
export const createJsonlJournalHarness = (directory: string) => ({
  layer: JournalJsonl(directory),
  reopen: () => JournalJsonl(directory),
  snapshotLines: (): Effect.Effect<ReadonlyArray<unknown>, JournalError> =>
    fileEffect(directory, "list directory", () => readdir(directory)).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(names.filter((name) => name.endsWith(".jsonl")).sort(), (name) =>
          fileEffect(join(directory, name), "read", () => readFile(join(directory, name), "utf8")),
        ),
      ),
      Effect.map((files) => files.flatMap((file) => linesFrom(file))),
    ),
});
