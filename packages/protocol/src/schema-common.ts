/**
 * Owns Schema parts shared by protocol frame families.
 * It exists to keep strict decoding and wire-number constraints consistent.
 */
import { Schema } from "effect";

export const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const StrictParseOptions: { readonly onExcessProperty: "error" } = {
  onExcessProperty: "error",
};
