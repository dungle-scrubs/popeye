import { expect, test } from "vitest";

import * as protocol from "./index.js";

test("exports the protocol package marker", () => {
  expect(protocol.protocolPackage).toBe("@dungle-scrubs/popeye-protocol");
});

test("exports every wire Schema and strict decoder from the package root", () => {
  expect(Object.keys(protocol)).toEqual(
    expect.arrayContaining([
      "CommandSchema",
      "InteractionRequestSchema",
      "InteractionResponseSchema",
      "ProgressSchema",
      "ResponseSchema",
      "SnapshotSchema",
      "decodeCommand",
      "decodeInteractionRequest",
      "decodeInteractionResponse",
      "decodeProgress",
      "decodeResponse",
      "decodeSnapshot",
    ]),
  );
});
