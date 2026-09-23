import { Effect } from "effect";

import type { HeadWriter } from "../heads/head-wire.js";

export const captureWriter = (): { readonly output: () => string; readonly writer: HeadWriter } => {
  const chunks: Array<string> = [];
  return {
    output: () => chunks.join(""),
    writer: { write: (text) => Effect.sync(() => void chunks.push(text)) },
  };
};
