// §13.10a live-wiring step 1 — the frontmatter format codec: the WRITER's `serializeScalar`
// (forward) and its INVERSE `deserializeScalar` + the field reader `readFrontmatterField`, now
// co-located in ONE module so the inverse provably cannot drift from the forward. The crown-jewel
// assertion is the round-trip PROPERTY: for every string v, deserializeScalar(serializeScalar(v)) === v.
// This is the read half of gate 1 (slug-collision): the on-approval executor's `readNoteProjectId`
// compares a note's on-disk frontmatter `projectId` against the plan's raw `expectedProjectId`, so the
// reader MUST return the UNESCAPED raw scalar (a quoted on-disk form would false-reject every legit
// re-proposal of a project whose id isn't a safe plain scalar).
//
// No RAW control BYTES appear in this source — every non-printable value is built via
// String.fromCharCode (the same discipline the writer's yamlDoubleQuote uses), so the file stays
// diff-safe and unambiguous.
import { describe, it, expect } from "vitest";
import {
  serializeScalar,
  deserializeScalar,
  readFrontmatterField,
} from "../src/knowledge-writer/frontmatter";

const ch = (code: number): string => String.fromCharCode(code);

// A curated corpus that exercises every branch of the forward serializer: safe-plain, empty,
// digit-leading (number/date/hex the YAML parser would re-type), YAML keywords, indicator/flow
// chars that force quoting, embedded quotes/backslashes, the explicit \n \r \t escapes, the C0/C1
// control set escaped as \xXX, U+2028/U+2029, and non-ASCII word chars (not \w, so quoted verbatim).
const CORPUS: readonly string[] = [
  "acme",
  "acme-corp",
  "key with spaces",
  "a.b/c-d",
  "",
  " leading",
  "trailing ",
  "  ",
  "2024-01-01",
  "0xFF",
  "0o17",
  "0b101",
  "42",
  "1.5",
  "true",
  "false",
  "no",
  "YES",
  "null",
  "off",
  "on",
  "a: b",
  "# comment",
  "- dash",
  "[bracket",
  "{brace",
  'has"quote',
  "back\\slash",
  'both\\"mixed',
  "tab\there",
  "nl\nhere",
  "cr\rhere",
  ch(0x0b), // vertical tab (in the escaped control set)
  ch(0x0c), // form feed
  ch(0x00), // NUL
  ch(0x7f), // DEL
  ch(0x85), // C1 NEL
  ch(0x2028), // line separator
  ch(0x2029), // paragraph separator
  "café", // non-\w letters ⇒ quoted, but no escapes inside
  "日本語",
  `mixed\tvalue with "quotes" and \\ and\nnewline`,
];

describe("frontmatter codec — deserializeScalar is the exact inverse of serializeScalar", () => {
  it("round-trips every corpus string: deserializeScalar(serializeScalar(v)) === v", () => {
    for (const v of CORPUS) {
      const wire = serializeScalar(v);
      expect(deserializeScalar(wire), `round-trip failed for ${JSON.stringify(v)} (wire ${JSON.stringify(wire)})`).toBe(v);
    }
  });

  it("returns a safe-plain scalar verbatim (never de-quotes an unquoted value)", () => {
    expect(deserializeScalar("acme")).toBe("acme");
    expect(deserializeScalar("acme-corp")).toBe("acme-corp");
    expect(deserializeScalar("key with spaces")).toBe("key with spaces");
  });

  it("unescapes each double-quoted escape sequence", () => {
    expect(deserializeScalar('"2024-01-01"')).toBe("2024-01-01");
    expect(deserializeScalar('""')).toBe("");
    expect(deserializeScalar('"a\\"b"')).toBe('a"b');
    expect(deserializeScalar('"a\\\\b"')).toBe("a\\b");
    expect(deserializeScalar('"a\\nb"')).toBe("a\nb");
    expect(deserializeScalar('"a\\rb"')).toBe("a\rb");
    expect(deserializeScalar('"a\\tb"')).toBe("a\tb");
    expect(deserializeScalar('"\\x0B"')).toBe(ch(0x0b));
    expect(deserializeScalar('"\\u2028"')).toBe(ch(0x2028));
  });

  it("is total on non-producible malformed input (best-effort, never throws)", () => {
    expect(() => deserializeScalar('"')).not.toThrow();
    expect(deserializeScalar('"')).toBe('"'); // len < 2 ⇒ verbatim
    expect(() => deserializeScalar('"a\\')).not.toThrow(); // dangling backslash
    expect(() => deserializeScalar('"\\xZZ"')).not.toThrow(); // bad hex
  });
});

describe("frontmatter codec — readFrontmatterField (the read half of gate 1)", () => {
  const note = (fmLines: string): string => `---\n${fmLines}\n---\nbody text\n`;

  it("returns undefined when the note has no frontmatter block", () => {
    expect(readFrontmatterField("just body, no frontmatter", "projectId")).toBeUndefined();
    expect(readFrontmatterField("", "projectId")).toBeUndefined();
  });

  it("returns undefined when the frontmatter has no such key", () => {
    expect(readFrontmatterField(note("title: Acme\nlifecycleState: active"), "projectId")).toBeUndefined();
  });

  it("reads a safe-plain projectId verbatim", () => {
    expect(readFrontmatterField(note("projectId: acme-corp\ntitle: Acme"), "projectId")).toBe("acme-corp");
  });

  it("reads and UNESCAPES a quoted (coercible/unsafe) projectId — the gate-1 correctness case", () => {
    // A digit-leading id is quoted on disk; the reader must return the raw id so the executor's
    // raw-equality compare against `expectedProjectId` holds.
    expect(readFrontmatterField(note('projectId: "2024-migration"\ntitle: X'), "projectId")).toBe("2024-migration");
    // A colon-bearing id is force-quoted; unescape must recover it (and the first-colon split must
    // not truncate at the value's inner colon).
    expect(readFrontmatterField(note('projectId: "a:b"\ntitle: X'), "projectId")).toBe("a:b");
  });

  it("survives a full serialize→compose→read round-trip for every corpus id", () => {
    for (const id of CORPUS) {
      const content = note(`projectId: ${serializeScalar(id)}\ntitle: T`);
      expect(readFrontmatterField(content, "projectId"), `note round-trip failed for ${JSON.stringify(id)}`).toBe(id);
    }
  });

  it("tolerates a note framed by OTHER tools: CRLF line endings, a leading BOM, an EOF close-fence", () => {
    // CRLF (Windows / a checked-out note) — parseNote's byte-exact `---\n` would otherwise miss it.
    expect(readFrontmatterField("---\r\nprojectId: acme\r\ntitle: X\r\n---\r\nbody\r\n", "projectId")).toBe("acme");
    // Leading UTF-8 BOM.
    expect(readFrontmatterField(`${ch(0xfeff)}---\nprojectId: acme\n---\nbody\n`, "projectId")).toBe("acme");
    // Closing fence at EOF with NO trailing newline.
    expect(readFrontmatterField("---\nprojectId: acme\n---", "projectId")).toBe("acme");
    // CRLF + a quoted (coercible) id still unescapes.
    expect(readFrontmatterField('---\r\nprojectId: "2024-x"\r\n---\r\n', "projectId")).toBe("2024-x");
  });
});
