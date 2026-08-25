// Repo-wide ESLint flat config (R1-a).
//
// Prior state (packages/contracts/LESSONS.md L89): every package's `lint` script
// was `tsc --noEmit` — ESLint was never installed, never configured, and the
// "lint" gate silently meant "typecheck" under another name. This file is the
// first real ESLint config in the repo; each package's `lint` script now points
// at `eslint .` (see each package.json), with `typecheck` kept as the separate
// `tsc --noEmit` script it already was — the two gates check different things
// and neither should collapse into the other again.
//
// Deliberately NON-type-checked (`tseslint.configs.recommended`, not
// `recommendedTypeChecked`): this is the first pass across 12 packages that have
// never been linted before, so the rule set stays syntactic/structural — it
// catches real bugs (unused vars, unreachable code, accidental `any`-shaped
// mistakes the parser can see) without requiring a `parserOptions.project` wired
// across every package's tsconfig. Tightening to type-aware rules is a
// follow-up, not a blocker for standing the gate up.
"use strict";

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

// packages/contracts and packages/domain are the §2.5 import-direction root
// (root CLAUDE.md; packages/contracts/CLAUDE.md forbidden pattern #2): they are
// PURE and must depend on nothing downstream. Encode that boundary as a real,
// enforced lint rule rather than a doc-only convention — an upward import is a
// silent architecture violation until something greps for it.
const DOWNSTREAM_IMPORT_PATTERNS = [
  "@sow/db",
  "@sow/db/*",
  "@sow/workflows",
  "@sow/workflows/*",
  "@sow/policy",
  "@sow/policy/*",
  "@sow/providers",
  "@sow/providers/*",
  "@sow/integrations",
  "@sow/integrations/*",
  "@sow/knowledge",
  "@sow/knowledge/*",
  "@sow/evals",
  "@sow/evals/*",
  "@sow/worker",
  "@sow/worker/*",
  "@sow/desktop",
  "@sow/desktop/*",
];

module.exports = tseslint.config(
  {
    // Generated output, dependency trees, and non-source artifacts never get linted.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.d.ts",
      "graphify-out/**",
      "apps/desktop/out/**",
      "apps/desktop/release/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // FIRST-PASS BASELINE (R1-a): this repo has never run ESLint before. A
      // full repo-wide run at default `recommended` severity surfaced real,
      // pre-existing hits scattered across packages/apps this work package does
      // NOT own (packages/contracts/src, packages/knowledge/src,
      // packages/workflows/src+test, apps/worker/src+test — other tracks are
      // live in those same files this session). This package's territory is
      // manifests + gate config only, never `packages/*/src` or `apps/*/src`
      // (or another package's `test/`), so those hits cannot be fixed here.
      //
      // Rather than either (a) leaving the gate permanently red for defects
      // outside this slice's scope, or (b) silently turning the checks off,
      // every rule below stays ACTIVE at "warn" — still parsed, still
      // reported, still visible in `pnpm lint` output — just not exit-code
      // fatal until each package's own owner cleans up its slice. `warn` is a
      // narrowing of severity, not a disabling of the check.
      "@typescript-eslint/no-explicit-any": "warn",

      // This codebase's own leading-underscore convention marks a
      // deliberately-unused parameter/binding (apps/worker/test,
      // packages/workflows/test, etc. use `_ws`, `_deps`, `_input`, ...
      // throughout) — teach the rule the convention instead of flagging it,
      // then warn (not error) on genuinely-unused non-underscore bindings
      // until each owning package cleans up its own pre-existing hits.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // Matching a control character (`\x00`-`\x1f`) is exactly the point of a
      // redaction/sanitization regex — packages/contracts/src/api/ui-safe.ts
      // and packages/knowledge/src/{knowledge-writer/frontmatter,synthesis/
      // grounded-path}.ts strip control characters on purpose. Off, not warn:
      // this rule cannot distinguish "sanitizer that removes a control char"
      // from "accidental control char in a pattern" by construction, so it is
      // structurally unable to earn a fix in this codebase's redaction code.
      "no-control-regex": "off",

      // 3 pre-existing hits outside this package's territory (a switch
      // fallthrough in packages/workflows/src/activities/healthItem.ts, a
      // `let` that's never reassigned + a redundant Boolean() call in test
      // files this slice doesn't own). Real bugs worth fixing, not this
      // slice's to fix — warn, not off, so they stay visible.
      "no-fallthrough": "warn",
      "prefer-const": "warn",
      "no-extra-boolean-cast": "warn",
    },
  },
  {
    // Forbidden pattern #2 (packages/contracts/CLAUDE.md): contracts + domain
    // are pure and depend on nothing downstream.
    files: ["packages/contracts/**/*.ts", "packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: DOWNSTREAM_IMPORT_PATTERNS.map((group) => ({
            group: [group],
            message:
              "packages/contracts and packages/domain are pure (§2.5 import-direction root) — they depend on nothing downstream. See packages/contracts/CLAUDE.md forbidden pattern #2.",
          })),
        },
      ],
    },
  },
  {
    // Config/build/tooling files run under plain Node, not the app's own
    // tsconfig — relax the TS-project-shaped rules that don't apply to them.
    files: ["**/*.config.{js,mjs,cjs,ts}", "**/*.build.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // apps/desktop/renderer is the React surface (electron-vite + React, root
    // CLAUDE.md stack table). Wire eslint-plugin-react-hooks's recommended
    // config here — without it, ESLint errors on the pre-existing
    // `// eslint-disable-next-line react-hooks/exhaustive-deps` comment in
    // Today.tsx ("Definition for rule ... was not found"), since a disable
    // directive can't reference a rule no plugin has registered.
    files: ["apps/desktop/renderer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
