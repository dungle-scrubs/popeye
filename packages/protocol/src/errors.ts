/**
 * Owns protocol failures so heads can render rejected wire input without ending a session.
 * It exists to keep malformed frames and invalid commands distinct from kernel failures.
 */
import { Data } from "effect";

export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly message: string;
  readonly reason: string;
}> {}

export class StaleRevision extends Data.TaggedError("StaleRevision")<{
  readonly actual: number;
  readonly expected: number;
}> {}

export class InteractionTimeout extends Data.TaggedError("InteractionTimeout")<{
  readonly requestId: string;
  readonly timeoutMs: number;
}> {}
