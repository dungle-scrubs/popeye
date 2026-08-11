const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "leafEntryId",
  "parentId",
  "sessionId",
  "toolCallId",
]);

const lines = (stream: string): ReadonlyArray<string> => stream.trimEnd().split("\n");

export const normalizeJsonStream = (stream: string): ReadonlyArray<unknown> => {
  const identifiers = new Map<string, string>();
  const normalize = (value: unknown, field: string | undefined): unknown => {
    if (field !== undefined && IDENTIFIER_FIELDS.has(field) && typeof value === "string") {
      const existing = identifiers.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const replacement = `<id-${identifiers.size + 1}>`;
      identifiers.set(value, replacement);
      return replacement;
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, undefined));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, normalize(item, key)]),
      );
    }
    return value;
  };

  return lines(stream).map((line) => normalize(JSON.parse(line) as unknown, undefined));
};

export const normalizeJsonLines = (stream: string): string =>
  `${normalizeJsonStream(stream)
    .map((value) => JSON.stringify(value))
    .join("\n")}\n`;
