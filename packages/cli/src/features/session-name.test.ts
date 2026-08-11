import type { CommandExecutionContext } from "@peye/plugins";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { sessionNamePlugin } from "./session-name.js";

test("session-name command ships as a Plugin using only the public command context", async () => {
  const command = sessionNamePlugin.contributions.find(
    (contribution) => contribution.kind === "command" && contribution.name === "session-name",
  );
  if (command?.kind !== "command") {
    throw new Error("Expected the session-name Command Contribution.");
  }
  let selectedName: string | undefined;
  const context: CommandExecutionContext = {
    compactNow: () => Effect.die("Unexpected compactNow call."),
    sessionId: Schema.decodeSync(Schema.String.pipe(Schema.brand("SessionId")))("session-1"),
    setSessionName: (name) =>
      Effect.sync(() => {
        selectedName = name;
      }),
  };

  await Effect.runPromise(command.payload.execute({ name: "Dogfood proof" }, context));

  expect(sessionNamePlugin.manifest).toMatchObject({ name: "session-name", version: "1.0.0" });
  expect(selectedName).toBe("Dogfood proof");
});
