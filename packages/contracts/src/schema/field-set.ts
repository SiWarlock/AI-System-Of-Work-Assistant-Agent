// 1.2 — top-level field-name extraction for schema-snapshot freezing (§12).
// Returns the sorted, unique TOP-LEVEL property names of a JSON Schema. For an
// anyOf/oneOf/allOf union, returns the sorted union of every member's top-level
// property names. Nested object structure is intentionally NOT walked — nested
// shape is frozen by the checked-in schema.json, not by the field-name set. PURE.

function collect(node: unknown, names: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;

  const props = schema["properties"];
  if (props !== null && typeof props === "object") {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      names.add(key);
    }
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    const members = schema[combinator];
    if (Array.isArray(members)) {
      for (const member of members) collect(member, names);
    }
  }
}

/** Sorted, unique top-level property names of a (possibly union) JSON Schema. */
export function fieldSet(jsonSchema: Record<string, unknown>): string[] {
  const names = new Set<string>();
  collect(jsonSchema, names);
  return [...names].sort();
}
