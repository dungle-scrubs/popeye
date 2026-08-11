/**
 * Owns PluginInteractions service, identity FiberRef contract, and fallback resolution.
 * It exists so Plugin code can request user interaction through a capability-gated seam
 * that stamps originating Plugin name and resolves fallbacks without failing Hooks.
 * Not responsible for transport (heads own that) or for Hook emission (emitter owns that).
 */

import {
  type InteractionRequest,
  type InteractionResponse,
  InteractionTimeout,
} from "@pop-eye/protocol";
import { Context, Effect, FiberRef, Layer, Option } from "effect";
import { type CapabilityGrants, hasCapability } from "./capability.js";

export const DEFAULT_INTERACTION_TIMEOUT_MILLIS = 25_000;

export const CurrentPluginFiberRef = FiberRef.unsafeMake<Option.Option<string>>(Option.none());

export const CurrentGrantsFiberRef = FiberRef.unsafeMake<Option.Option<CapabilityGrants>>(
  Option.none(),
);

export interface PluginInteractionRequest {
  readonly fallback: InteractionRequest["fallback"];
  readonly id: string;
  readonly kind: InteractionRequest["kind"];
  readonly options?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly placeholder?: string;
  readonly pluginName?: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly timeoutMs?: number;
}

export interface PluginInteractionResolution {
  readonly error?: InteractionTimeout;
  readonly pluginName?: string;
  readonly response: InteractionResponse;
  readonly source: "fallback" | "head";
}

export interface PluginInteractionsService {
  readonly request: (
    request: PluginInteractionRequest,
  ) => Effect.Effect<PluginInteractionResolution>;
}

export class PluginInteractions extends Context.Tag("@pop-eye/plugins/PluginInteractions")<
  PluginInteractions,
  PluginInteractionsService
>() {}

const fallbackResponse = (request: PluginInteractionRequest): InteractionResponse => {
  switch (request.kind) {
    case "confirm":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "confirm",
        value: (request.fallback as { kind: "confirm"; value: boolean }).value,
      };
    case "input":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "input",
        value: (request.fallback as { kind: "input"; value: string }).value,
      };
    case "select":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "select",
        value: (request.fallback as { kind: "select"; value: string }).value,
      };
  }
};

const toProtocolRequest = (
  request: PluginInteractionRequest,
  pluginName: string | undefined,
): InteractionRequest => {
  const timeoutMs = request.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MILLIS;
  const base = {
    _tag: "interaction-request" as const,
    fallback: request.fallback,
    id: request.id,
    ...(pluginName ? { pluginName } : {}),
    prompt: request.prompt,
    timeoutMs,
  };
  if (request.kind === "select") {
    return {
      ...base,
      kind: "select" as const,
      options: request.options ?? [],
    } as InteractionRequest;
  }
  if (request.kind === "input") {
    return {
      ...base,
      kind: "input" as const,
      ...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
    } as InteractionRequest;
  }
  return {
    ...base,
    kind: "confirm" as const,
  } as InteractionRequest;
};

const fallbackResolution = (
  request: PluginInteractionRequest,
  pluginName: string | undefined,
): PluginInteractionResolution => {
  const protocolRequest = toProtocolRequest(request, pluginName);
  return {
    error: new InteractionTimeout({
      requestId: request.id,
      timeoutMs: protocolRequest.timeoutMs,
    }),
    ...(pluginName ? { pluginName } : {}),
    response: fallbackResponse(request),
    source: "fallback",
  };
};

export const makePluginInteractionsNullService = (): PluginInteractionsService => ({
  request: (request) =>
    Effect.gen(function* () {
      const pluginOption = yield* FiberRef.get(CurrentPluginFiberRef);
      const pluginName = Option.getOrElse(pluginOption, () => "unknown");
      const stampedPluginName =
        request.pluginName ?? (pluginOption._tag === "Some" ? pluginOption.value : undefined);
      const grantsOption = yield* FiberRef.get(CurrentGrantsFiberRef);
      const grants = Option.getOrUndefined(grantsOption);
      const hasInteraction = grants !== undefined && hasCapability(grants, "interaction");
      if (!hasInteraction) {
        yield* Effect.logWarning(
          "Plugin interaction without capability grant resolved with fallback.",
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "interaction_ungranted",
            kind: request.kind,
            plugin: pluginName,
            requestId: request.id,
          }),
        );
        return fallbackResolution(request, stampedPluginName);
      }
      yield* Effect.logWarning("Plugin interaction resolved with fallback (null layer).").pipe(
        Effect.annotateLogs({
          diagnostic: "interaction_fallback",
          kind: request.kind,
          outcome: "fallback",
          plugin: pluginName,
          requestId: request.id,
        }),
      );
      return fallbackResolution(request, stampedPluginName);
    }),
});

export const PluginInteractionsNullLive: Layer.Layer<PluginInteractions> = Layer.effect(
  PluginInteractions,
  Effect.sync(makePluginInteractionsNullService),
);

/**
 * Helper for live layer: creates a PluginInteractions service that delegates to a transport
 * after capability gating and stamping. The transport is expected to handle timeout, attach,
 * and interruption semantics (like RpcInteractions).
 */
export const makePluginInteractionsLiveService = (options: {
  readonly transport: (
    sessionId: string | undefined,
    request: InteractionRequest,
  ) => Effect.Effect<PluginInteractionResolution, unknown>;
}): PluginInteractionsService => ({
  request: (request) =>
    Effect.gen(function* () {
      const pluginOption = yield* FiberRef.get(CurrentPluginFiberRef);
      const pluginName = Option.getOrElse(pluginOption, () => "unknown");
      const stampedPluginName =
        request.pluginName ?? (Option.isSome(pluginOption) ? pluginOption.value : undefined);
      const grantsOption = yield* FiberRef.get(CurrentGrantsFiberRef);
      const grants = Option.getOrUndefined(grantsOption);
      const hasInteraction = grants !== undefined && hasCapability(grants, "interaction");
      if (!hasInteraction) {
        yield* Effect.logWarning(
          "Plugin interaction without capability grant resolved with fallback.",
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "interaction_ungranted",
            kind: request.kind,
            plugin: pluginName,
            requestId: request.id,
          }),
        );
        return fallbackResolution(request, stampedPluginName);
      }
      const protocolRequest = toProtocolRequest(request, stampedPluginName);
      // Log request
      yield* Effect.logInfo("Plugin interaction request.").pipe(
        Effect.annotateLogs({
          diagnostic: "interaction_request",
          kind: request.kind,
          plugin: pluginName,
          requestId: request.id,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          timeoutMs: protocolRequest.timeoutMs,
        }),
      );
      const resolution = yield* options.transport(request.sessionId, protocolRequest).pipe(
        Effect.tapBoth({
          onFailure: () =>
            Effect.logWarning("Plugin interaction transport failed, using fallback.").pipe(
              Effect.annotateLogs({
                diagnostic: "interaction_transport_failed",
                kind: request.kind,
                plugin: pluginName,
                requestId: request.id,
              }),
            ),
          onSuccess: (res) =>
            Effect.logInfo("Plugin interaction resolved.").pipe(
              Effect.annotateLogs({
                diagnostic: "interaction_resolution",
                kind: request.kind,
                outcome: res.source,
                plugin: pluginName,
                requestId: request.id,
                source: res.source,
              }),
            ),
        }),
        Effect.catchAll(() => Effect.succeed(fallbackResolution(request, stampedPluginName))),
      );
      return resolution;
    }),
});

export const makePluginInteractionsLiveLayer = (options: {
  readonly transport: (
    sessionId: string | undefined,
    request: InteractionRequest,
  ) => Effect.Effect<PluginInteractionResolution, unknown>;
}): Layer.Layer<PluginInteractions> =>
  Layer.effect(
    PluginInteractions,
    Effect.sync(() => makePluginInteractionsLiveService(options)),
  );
