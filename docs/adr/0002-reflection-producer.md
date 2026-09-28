---
status: accepted
---

# Session lifecycle reaches the reflection intake through a kernel send, not a Tap

The reflection intake (reflect-intake, RFC-03 slice 16) needs to know when a direct Popeye
Session is created, resumed, and closed. It needs a start record that survives a crash, so that a
Session killed before it could close is later reported as interrupted, never as a clean close.

The `session-lifecycle` Hook point cannot carry this. It is a `Tap` point with the `drop` failure
policy. Each Hook has a bounded queue of 64 items; when the queue is full, the oldest item is
dropped and the emitter reports `hook_tap_dropped`. A Tap notification is a diagnostic hint by
construction.

We split the signal in two. Both are reported from the same Kernel seams:

- **Diagnostic broadcast.** The end of `create` and `resume` in `packages/kernel/src/sessions.ts`
  and the end of `closeSession` in `packages/kernel/src/driver.ts` emit the `session-lifecycle`
  Tap input `{ event, sessionId }`. The Kernel receives the emit as a function
  (`DriverDefaultOptions.lifecycle`), so it never imports the Plugin package.
- **Durable send.** The same seams call `packages/kernel/src/reflection-producer.ts`. It spawns
  `<POPEYE_REFLECT_INTAKE> hook popeye <created|resumed|closed>` directly. The spawn is detached
  and unref'd. The child gets one JSON payload on stdin and the caller environment unchanged.
  Popeye never waits for the flush or the exit. The intake owns envelopes, outboxes, authorities,
  and the gate.

Each call is failure isolated: a Tap failure, a spawn failure, or a failed file write never fails,
delays, or changes a Session operation.

This is **reporting**. Removing it changes no Session outcome.

## The send

- `POPEYE_REFLECT_INTAKE` holds the absolute path of the intake executable. When it is unset,
  empty, relative, or not an executable regular file, there is no producer, no start record, and
  no sweep. The run is the same as without this ADR. There is no flag and no config-file key.
- Every create and resume mints an activation ID (a UUID). The payload is
  `{ activationId, event, occurredAt, pid, sessionId }`. A close adds `drainedWithinGrace`. A
  Head exit also adds `headExit: true`. A reconciled close is
  `{ activationId, event: "closed", pid, reconciled: true, sessionId, startedAt }`.
- The intake derives its invocation from the Session ID and the activation ID. So a close names
  the activation it ends, whatever order the detached hook processes run in.
- Before the start is sent, the producer writes a start record:
  `<session dir>/reflection/<sessionId>.json`, holding
  `{ activationId, closed: false, event, pid, sessionId, startedAt }`. It is written to a
  temporary file and then renamed. A failed write still sends.
- After a close is initiated, the record is marked `closed: true`, and only while it still names
  that activation.
- The Journal keeps only Journal files. Journal adapters list only `.jsonl` files and
  `journal.sqlite`, so they ignore the `reflection` subdirectory.

## Close contract

- `closeSession` reports `closed` with `drainedWithinGrace` from its own result. It reports only
  after the abort-plus-drain settle and the Snapshot read.
- The print, json, and hcn Heads end without `closeSession`. When `runSessionLoop` returns
  normally, it reports a clean close (`headExit: true`) for its Session.
- The RPC Head reports a clean close for every Session still open when its input ends normally.
  That report runs after queued commands finish.
- One process reports at most one close per activation. An explicit RPC `close` followed by end
  of input reports once.
- A thrown error, a defect, a crash, or SIGKILL skips the report.

## Reconciliation

Before every durable send, the producer sweeps the start records in its Session directory. A
record with `closed: false` gets a reconciled close when two things hold:

- its process is dead: signal 0 fails with `ESRCH`. `EPERM` counts as alive, and any other error
  is unknown;
- the Journal still lists its Session.

The intake records that close as `cause: "killed"`, `interrupted: true`, so the revision is
incomplete. A live or unknown process is left alone: silence is neither completion nor failure.
The pid is used for liveness only, never for identity. A reconciled payload is rebuilt from the
record alone, so a re-send is byte-identical and the intake answers `duplicate`.

The sweep covers the Session directory of the process that runs it. A record in another Session
directory is swept by the next Popeye process that uses that directory.

## Considered options

- **Tap-only delivery**: a Plugin that runs the hook from the `session-lifecycle` Tap. Rejected.
  The Tap drops under load by design, and a dropped close is a lost fact.
- **Calling `reflect-intake capture`**: rejected. Popeye would build envelopes and would need to
  know authorities and the gate. Other harnesses reach the intake through
  `reflect-intake hook <harness> <event>`.
- **A state-directory spool read by the intake**: rejected. It adds a second delivery path with
  its own ordering and cleanup rules. The intake would also have to read Popeye state.
- **Journal polling by the intake**: rejected. It couples the intake to Popeye's Journal format,
  and lifecycle facts would arrive only after a polling interval.
- **Minting the invocation in the hook with a per-Session state file**, as for Claude and pi:
  rejected for Popeye. A sweep's reconciled close and the next process's resume are two detached
  hooks for the same Session. They race on that file, and the close could end the new revision.
  The activation ID removes the race.

## Consequences

- Delegation creates child Sessions through the same `create` seam, so each child Session is
  reported. No delegation parent is sent: parent linkage is left out, never inferred from timing
  or Session order.
- Under HCN (`HCN_INVOCATION_ID`) or a Graybox Task (`REFLECT_INTAKE_WORK_PARENT`), the inherited
  environment reaches the hook unchanged. The intake then records every Popeye report as evidence
  of that outer work, not as its own item. Popeye applies no parent logic of its own.
- Known gaps. The intake sees each one as a revision without a clean end:
  - A crash between the Journal create and the start record leaves only the Journal Session.
  - A crash between the start record and the start send gives the next sweep a reconciled close
    with no start before it. The intake records it as a separate provisional item, with one
    incomplete revision and a `no-substantive-turn` gap. It never claims a clean close.
  - A SIGKILL of the hook child before it commits loses that one report.
  - A close whose spawn was not initiated leaves `closed: false`. The next sweep then reports the
    activation as killed.
  - A pid reused by a live process keeps its record open until that process dies.
- Paths that end a Session with no close report are listed in
  [the Plugin guide](../plugin-authoring.md#diagnostic-versus-durable-signals).
