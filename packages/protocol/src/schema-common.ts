/**
 * Owns Schema parts shared by protocol frame families.
 * It exists to keep frame decoding and wire-value constraints consistent.
 */
import { Schema } from "effect";

export const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const OtherEnumValueSchema = Schema.TaggedStruct("other", {
  value: Schema.NonEmptyString,
});

export type OtherEnumValue = Schema.Schema.Type<typeof OtherEnumValueSchema>;

export const LenientParseOptions: { readonly onExcessProperty: "ignore" } = {
  onExcessProperty: "ignore",
};

export const StrictParseOptions: { readonly onExcessProperty: "error" } = {
  onExcessProperty: "error",
};
