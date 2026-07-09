// Frontmatter format codec — the on-disk `---` block contract shared by the KnowledgeWriter's
// projection (write side) and any reader that must recover a frontmatter value (read side).
//
// This module owns the WHOLE codec so the FORWARD serializer and its INVERSE cannot drift apart:
//   • serializeScalar  — a model/domain-authored value → a YAML-safe scalar (§13.10a gate 2).
//   • deserializeScalar — the exact inverse over the string range of serializeScalar.
//   • parseNote / composeNote — split/re-emit the `---`-fenced block (round-trip stable, verbatim).
//   • readFrontmatterField — read one frontmatter key back as its UNESCAPED raw value (parse ∘ inverse).
//
// The round-trip PROPERTY `deserializeScalar(serializeScalar(v)) === v` (pinned by test) is what makes
// gate 1 (slug-collision) correct: the on-approval executor compares a note's on-disk frontmatter
// `projectId` against the plan's RAW `expectedProjectId`, so the reader must undo the writer's quoting.
//
// The writer (writer.ts) imports serializeScalar / parseNote / composeNote from here; the region/link
// projection logic stays in the writer. Non-string values keep their compact JSON form (numbers /
// booleans / null are already valid YAML plain scalars).

const FM_FENCE = "---";

/**
 * YAML-safe frontmatter scalar serialization (§13.10a go-live gate 2 — the first untrusted→frontmatter
 * exposure). A model/domain-authored STRING is emitted as a plain scalar ONLY when it is unambiguously
 * safe; otherwise it is double-quoted + escaped so a real vault (Obsidian / gbrain ingest) cannot
 * misparse a value that starts with a YAML indicator or carries a flow/comment ambiguity (`: `, ` #`,
 * `[`, `#`, …). The writer's own parseNote/composeNote round-trip stays stable: parseNote reads a value
 * verbatim and composeNote re-emits it verbatim, so a re-parsed already-quoted value is NEVER
 * double-quoted (only a fresh set/patch value is re-serialized). Non-string values keep their compact
 * JSON form (numbers/booleans/null are already valid YAML plain scalars).
 */
export function serializeScalar(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  return needsYamlQuoting(value) ? yamlDoubleQuote(value) : value;
}

/**
 * Inverse of `serializeScalar` over its STRING range: given the RAW on-disk scalar text, return the
 * original string value. A double-quoted form (`"…"`) is unescaped (the inverse of `yamlDoubleQuote`);
 * any other form is a safe plain scalar and is returned verbatim. Pure; total; NEVER throws.
 *
 * INVARIANT (pinned by the round-trip property test): `deserializeScalar(serializeScalar(v)) === v` for
 * every string `v`. `serializeScalar` only ever emits a plain scalar or a double-quoted scalar, and a
 * plain scalar can NEVER begin with `"` (the safe-plain form requires a letter start), so the two
 * branches below are an exact, unambiguous inverse over that range. Non-producible malformed input
 * (a hand-edited note) is handled best-effort — a dangling `\` or a bad `\xZZ`/`\uZZZZ` keeps the
 * backslash literally rather than throwing.
 */
export function deserializeScalar(raw: string): string {
  // A plain scalar (serializeScalar never wraps a plain value in quotes). Also covers a lone `"`.
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = inner[i + 1];
    switch (n) {
      case "\\":
        out += "\\";
        i += 1;
        break;
      case '"':
        out += '"';
        i += 1;
        break;
      case "n":
        out += "\n";
        i += 1;
        break;
      case "r":
        out += "\r";
        i += 1;
        break;
      case "t":
        out += "\t";
        i += 1;
        break;
      case "x": {
        const hex = inner.slice(i + 2, i + 4);
        if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
        } else {
          out += c; // non-producible malformed escape — keep the backslash literally
        }
        break;
      }
      case "u": {
        const hex = inner.slice(i + 2, i + 6);
        if (/^[0-9A-Fa-f]{4}$/u.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          out += c;
        }
        break;
      }
      default:
        out += c; // unknown / dangling escape (not producible by serializeScalar) — keep it literally
    }
  }
  return out;
}

/** True when a string is NOT an unambiguously-safe YAML plain scalar (⇒ must be double-quoted). */
function needsYamlQuoting(s: string): boolean {
  if (s.length === 0) return true; // empty ⇒ must quote
  if (s !== s.trim()) return true; // leading/trailing whitespace flips a plain scalar's meaning
  // Safe plain = starts with a LETTER, then only word-chars + space + inert punctuation. Requiring a
  // LETTER start (never a digit) is load-bearing: it forces EVERY digit-leading value — a number, an
  // ISO date `2020-01-01`, hex `0x1F`, octal `0o17`, binary `0b101`, a version — down the quote path,
  // so a real YAML parser (Obsidian / gbrain ingest, YAML 1.1) can never re-TYPE it. Any indicator /
  // `: ` / ` #` / newline / control char also fails this and is quoted.
  if (!/^[A-Za-z][\w ./-]*$/u.test(s)) return true;
  // A letter-leading plain scalar YAML would TYPE as bool/null ⇒ quote to keep it a string.
  if (/^(y|yes|n|no|true|false|on|off|null)$/iu.test(s)) return true;
  return false;
}

/** Escape a string as a YAML double-quoted scalar (the always-safe quoting style). */
function yamlDoubleQuote(s: string): string {
  const escaped = s
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")
    // Any REMAINING non-printable char (C0 minus the above, DEL, C1, U+2028/U+2029) → a \xXX / \uXXXX
    // escape. A raw control char inside `"…"` is NOT `c-printable`, so a strict YAML parser would reject
    // the whole frontmatter block — escaping keeps the note metadata readable.
    .replace(new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F\\u2028\\u2029]", "gu"), (c) => {
      const code = c.charCodeAt(0);
      return code <= 0xff
        ? `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    });
  return `"${escaped}"`;
}

interface ParsedNote {
  readonly frontmatter: Map<string, string>;
  readonly body: string;
}

/**
 * Split a note into its `---`-fenced frontmatter map + body. The map holds RAW on-disk values (the
 * verbatim text after the first `:` on each line, trimmed) — it does NOT unescape (that keeps the
 * writer's read→re-emit round-trip byte-stable). Apply `deserializeScalar` to a value to recover the
 * original scalar (see `readFrontmatterField`). A note without a well-formed opening fence is all body.
 */
export function parseNote(content: string): ParsedNote {
  const frontmatter = new Map<string, string>();
  if (!content.startsWith(`${FM_FENCE}\n`)) {
    return { frontmatter, body: content };
  }
  const closeIdx = content.indexOf(`\n${FM_FENCE}\n`, FM_FENCE.length);
  if (closeIdx === -1) {
    return { frontmatter, body: content };
  }
  const block = content.slice(FM_FENCE.length + 1, closeIdx);
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    frontmatter.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const body = content.slice(closeIdx + FM_FENCE.length + 2);
  return { frontmatter, body };
}

/** Re-emit a frontmatter map + body as note content (verbatim; the inverse of `parseNote`). */
export function composeNote(frontmatter: ReadonlyMap<string, string>, body: string): string {
  if (frontmatter.size === 0) {
    return body;
  }
  const lines = [...frontmatter.entries()]
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `${FM_FENCE}\n${lines}\n${FM_FENCE}\n${body}`;
}

/**
 * Read a single frontmatter scalar field from note CONTENT, returning the UNESCAPED raw value (parse ∘
 * `deserializeScalar`) — the read counterpart of `serializeScalar`. `undefined` when the note has no
 * frontmatter block OR no such key. Pure; never throws.
 *
 * This is the deterministic core of gate 1's `readNoteProjectId`: the executor compares the returned
 * value against the plan's raw `expectedProjectId` by string equality, so returning the QUOTED on-disk
 * form (e.g. `"2024-x"` for raw `2024-x`) would false-REJECT every legit re-proposal of a project whose
 * id isn't a safe plain scalar. The unescape is what keeps the compare sound.
 *
 * Unlike the writer's own `parseNote` (which is byte-exact over content the writer itself emits), the
 * READER faces notes framed by OTHER tools — so it normalizes an UNTRUSTED on-disk note first: strip a
 * leading UTF-8 BOM, fold CRLF→LF, and tolerate a closing fence at EOF (no trailing newline). Without
 * this a legitimately-framed project note (checked out CRLF, BOM-prefixed) would parse as
 * frontmatter-less → the field reads `undefined` → gate 1 would MISjudge the note's owning project (a
 * false-reject on a patch; a false-"free" on a create). The writer's round-trip is unaffected — this
 * normalization lives only in the reader.
 */
export function readFrontmatterField(content: string, key: string): string | undefined {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lf = stripped.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const normalized = lf.endsWith("\n") ? lf : `${lf}\n`; // let parseNote find a `\n---\n` close at EOF
  const raw = parseNote(normalized).frontmatter.get(key);
  return raw === undefined ? undefined : deserializeScalar(raw);
}
