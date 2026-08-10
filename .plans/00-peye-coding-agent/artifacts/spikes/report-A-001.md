# A-001 - pi-ai event stream to Effect Stream

## What ran

`npx tsx spike-a001.ts` against `@earendil-works/pi-ai@0.84.1` and `effect@3.22.1`.

The spike uses the public `createAssistantMessageEventStream()` factory to obtain actual `AssistantMessageEventStream` instances, then wraps each with `Stream.fromAsyncIterable`. The adapter maps a terminal pi-ai `error` event to a typed `ProviderTerminalError` using `Stream.mapEffect`; an iterator throw would map to `ProviderIterationError`.

## Assertions and observations

- A replay fixture emitted `start`, text, thinking, tool-call, and `done` events. `Stream.runCollect` observed the exact emitted order, including the terminal `done` event.
- The successful fixture's `stream.result()` resolved to the same final assistant message carried by `done`, with `stopReason: "toolUse"`.
- An error-terminal fixture produced an Effect `Either.Left(ProviderTerminalError)`, not a thrown JavaScript error. Its `stream.result()` resolved to the same `AssistantMessage` with `stopReason: "error"`.
- `isRetryableAssistantError` imported from the pi-ai package and returned `true` for the error fixture with `errorMessage: "temporary network timeout"`.
- An abort-terminal fixture likewise produced `ProviderTerminalError` and settled `result()` with `stopReason: "aborted"`.
- Interrupting the consuming Effect fiber did interrupt that fiber, but did not cancel the independently running producer. The producer continued and pushed its terminal event after consumer interruption. `AssistantMessageEventStream` exposes `push`, `end`, and `result`, but no public cancellation or abort hook that the adapter can invoke.
- The requested live-provider half was skipped because network access is prohibited for this task.

## Conclusion

`Stream.fromAsyncIterable` preserves the public pi-ai event protocol and supports typed conversion of terminal error events, but it does not itself provide request cancellation. The seam needs an explicit abort/cancellation bridge owned by the caller or a buffering/normalization layer before it can meet the full interruption requirement.

VERDICT: fail
