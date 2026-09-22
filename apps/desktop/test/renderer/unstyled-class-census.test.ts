// Every `sow-*` class the renderer puts on an element must have a rule in styles.css — or be a
// NAMED structural hook with a stated reason.
//
// ⛔ THE DEFECT CLASS, owner report 2026-09-21 ("the inbox page looks terrible"): the Inbox rendered as
// a raw bullet list with browser-default buttons because its 15 class names had ZERO rules. A census
// then found 53 such names across 10 screens (Today, Calendar, Projects, Egress, Approvals, Connectors
// — including a hint added the same day — Onboarding, Links, Health). Nothing failed: a class with no
// rule is valid HTML, typechecks, and passes every behaviour test. The screen just looks broken.
// ⇒ this guard makes an unstyled class a RED test at the moment it is introduced.
//
// Node tier, structural (desktop LESSONS §3) — jsdom computes no styles, so a DOM test cannot see this.
//
// ⚠ It reads ONLY `className` attributes. The first census counted every `sow-*` token in the file and
// flagged an element ID (`id="sow-cadence-hint"`) as an unstyled class — a false alarm. Template-built
// modifiers (`sow-ingestion-btn--${disposition}`) are skipped here; their resolved values are styled by
// name in styles.css and checked by eye, since a regex cannot enumerate runtime values.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../../renderer/", import.meta.url));
const CSS = readFileSync(join(RENDERER, "styles.css"), "utf8");

/**
 * Class names that intentionally carry NO rule of their own. Each is a hook on an element whose look
 * comes entirely from another class on the same element (or from its children). Adding one here means
 * writing down why it needs no style — the reason is the point.
 */
const STRUCTURAL_HOOKS: Readonly<Record<string, string>> = {
  "sow-connectors": "page root; .sow-content styles the pane",
  "sow-onboarding": "page root; .sow-content styles the pane",
  "sow-cross-workspace-links": "page root; .sow-content styles the pane",
  "sow-system-health": "page root; .sow-content styles the pane",
  "sow-settings": "page root; .sow-content styles the pane",
  "sow-connectors-error": "paired with .sow-inline-error on the same element",
  "sow-onboarding-error": "paired with .sow-inline-error on the same element",
  "sow-cross-workspace-links-error": "paired with .sow-inline-error on the same element",
  "sow-egress-error": "paired with .sow-inline-error on the same element",
  "sow-pill--egress-scoped": "the neutral base .sow-pill is deliberate: any tint would imply safe/unsafe on a rule-5 surface",
  "sow-global-group": "section wrapper; .sow-global-groups sets the layout, children carry the look",
  "sow-workflow-runs": "hook on the same element as .sow-activity, which supplies the look",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

/** The text of every `className=` value: a "..." literal, or a balanced {...} expression. */
function classNameValues(src: string): string[] {
  const out: string[] = [];
  const re = /className=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    const open = src[i];
    if (open === '"' || open === "'") {
      const end = src.indexOf(open, i + 1);
      if (end > i) out.push(src.slice(i + 1, end));
      continue;
    }
    if (open !== "{") continue;
    let depth = 0;
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

/** `sow-*` class tokens in a className value, excluding template-built prefixes (`sow-x--${...}`). */
function classTokens(value: string): string[] {
  const out: string[] = [];
  for (const t of value.match(/sow-[A-Za-z0-9_-]+/g) ?? []) {
    if (!t.endsWith("-")) out.push(t);
  }
  return out;
}

const definedInCss = new Set((CSS.match(/\.sow-[A-Za-z0-9_-]+/g) ?? []).map((s) => s.slice(1)));

const used = new Map<string, Set<string>>();
for (const file of walk(RENDERER)) {
  const rel = file.slice(RENDERER.length);
  for (const value of classNameValues(readFileSync(file, "utf8"))) {
    for (const cls of classTokens(value)) {
      if (!used.has(cls)) used.set(cls, new Set());
      used.get(cls)?.add(rel);
    }
  }
}

describe("every renderer class name is styled, or is a named structural hook", () => {
  it("the census actually reads the renderer — non-vacuous", () => {
    // Without this, a broken walk or regex would find zero classes and pass everything below.
    expect(used.size).toBeGreaterThan(150);
    expect(used.has("sow-ingestion-card")).toBe(true);
  });

  it("⛔ no class name is used without a rule", () => {
    const unstyled = [...used.entries()]
      .filter(([cls]) => !definedInCss.has(cls) && !(cls in STRUCTURAL_HOOKS))
      .map(([cls, files]) => `${cls}  (${[...files].join(", ")})`);
    expect(unstyled).toEqual([]);
  });

  it("does not count element IDs as classes (the first census's false alarm)", () => {
    // `sow-cadence-hint` is an id on the Connectors page, not a class. It must not appear here.
    expect(used.has("sow-cadence-hint")).toBe(false);
  });

  it("every structural hook is still in use — the allowlist cannot silently go stale", () => {
    const stale = Object.keys(STRUCTURAL_HOOKS).filter((cls) => !used.has(cls));
    expect(stale).toEqual([]);
  });

  it("no structural hook has quietly gained a rule — then it belongs off the list", () => {
    const nowStyled = Object.keys(STRUCTURAL_HOOKS).filter((cls) => definedInCss.has(cls));
    expect(nowStyled).toEqual([]);
  });
});
