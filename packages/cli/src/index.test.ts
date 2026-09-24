import { expect, test } from "vitest";

import * as cli from "./index.js";

test("exports the cli package marker", () => {
  expect(cli.cliPackage).toBe("@dungle-scrubs/popeye");
});

test("exports the rpc Head and interaction transport", () => {
  expect(cli.runRpcHead).toBeTypeOf("function");
  expect(cli.strictLfFrames).toBeTypeOf("function");
  expect(cli.RpcInteractions).toBeTypeOf("function");
  expect(cli.RpcInteractionsLive).toBeDefined();
});
