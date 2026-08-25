// Task 22.1 — gateProposeArming: the composite propose precondition gate. A PURE fn (mirrors
// gateReconcile/gateRebuildOracle, Lesson 2/8/23) — no I/O, no construction — so it is directly
// unit-testable without booting. `{propose:'OFF', reason:<first-missing-precondition>}` when any ONE of
// the five preconditions is absent; `{propose:'ON'}` only when all five pass.
//
// COVERAGE OF THE UNCONDITIONAL `withProposeKnowledgeApproval` BIND (task 22.1's explicit ask): that
// bind (boot.ts, `withProposeKnowledgeApproval`) constructs the propose-knowledge-approval PORT
// whenever `proofSpineParams !== undefined` — deliberately NOT gated by this composite verdict (a
// lead-ruled single-gate design; see the function's own doc comment). The "propose is OFF" claim this
// suite defends is therefore about the MODEL-FACING CAPABILITY the resolver grants
// (`proposeEnabled`/`knowledgeProposeEnabled`), not about whether the inert port object exists — a card
// can only ever reach that port if a propose-tier plan is PRODUCED, and nothing produces one unless the
// resolver first grants the tool. The source pin below asserts BOTH resolver mappings are gated by
// `proposeArming.propose === "ON"` (so a missing precondition holds the MODEL-FACING GRANT closed even
// though the port itself is unconditionally constructed) — a test pinning only `gateProposeArming` in
// isolation would not catch a regression where the boot call site stopped reading its verdict.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { gateProposeArming, type ProposeArmingPreconditions } from "../../src/boot";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_SRC = resolve(HERE, "../../src/boot.ts");
const bootSource = readFileSync(BOOT_SRC, "utf8");

/** All five preconditions honored — the baseline every "missing precondition" case flips ONE bit off. */
const ALL_PASS: ProposeArmingPreconditions = {
  contentTrustReal: true,
  proofSpineProvisioned: true,
  signingKeyResolved: true,
  writeTransportArmed: true,
  provenanceStampingReal: true,
};

describe("gateProposeArming — the composite five-precondition gate (task 22.1)", () => {
  it("all five preconditions present ⇒ {propose:'ON'}", () => {
    expect(gateProposeArming(ALL_PASS)).toEqual({ propose: "ON" });
  });

  it("contentTrustReal absent ⇒ OFF, reason names it FIRST", () => {
    expect(gateProposeArming({ ...ALL_PASS, contentTrustReal: false })).toEqual({
      propose: "OFF",
      reason: "content_trust_not_real",
    });
  });

  it("proofSpineProvisioned absent ⇒ OFF, reason names it", () => {
    expect(gateProposeArming({ ...ALL_PASS, proofSpineProvisioned: false })).toEqual({
      propose: "OFF",
      reason: "proof_spine_not_provisioned",
    });
  });

  it("signingKeyResolved absent ⇒ OFF, reason names it", () => {
    expect(gateProposeArming({ ...ALL_PASS, signingKeyResolved: false })).toEqual({
      propose: "OFF",
      reason: "signing_key_not_resolved",
    });
  });

  it("writeTransportArmed absent ⇒ OFF, reason names it", () => {
    expect(gateProposeArming({ ...ALL_PASS, writeTransportArmed: false })).toEqual({
      propose: "OFF",
      reason: "write_transport_not_armed",
    });
  });

  it("provenanceStampingReal absent ⇒ OFF, reason names it", () => {
    expect(gateProposeArming({ ...ALL_PASS, provenanceStampingReal: false })).toEqual({
      propose: "OFF",
      reason: "provenance_stamping_not_real",
    });
  });

  it("MULTIPLE preconditions absent ⇒ reports the FIRST in fixed check order, not a summary", () => {
    // contentTrustReal AND writeTransportArmed both false — the verdict names ONLY the first-checked.
    expect(
      gateProposeArming({ ...ALL_PASS, contentTrustReal: false, writeTransportArmed: false }),
    ).toEqual({ propose: "OFF", reason: "content_trust_not_real" });
    // signingKeyResolved AND provenanceStampingReal both false — signing is checked before provenance.
    expect(
      gateProposeArming({ ...ALL_PASS, signingKeyResolved: false, provenanceStampingReal: false }),
    ).toEqual({ propose: "OFF", reason: "signing_key_not_resolved" });
  });

  it("task 24.2 — a truthy-not-`true` value (the string \"false\", 1, {}) on writeTransportArmed resolves OFF, never arms (Lesson 28)", () => {
    // gateProposeArming's parameter type is `boolean`, so a caller must CAST to reach this — mirroring
    // Lesson 28's discipline (a config/env-sourced value can be ANY JS value at runtime, not just what
    // the type claims). Strict `!== true` inside the gate means EVERY one of these degrades to OFF.
    for (const truthyNonTrue of ["false", 1, {}, "true", [] as unknown] as const) {
      const verdict = gateProposeArming({
        ...ALL_PASS,
        writeTransportArmed: truthyNonTrue as unknown as boolean,
      });
      expect(verdict).toEqual({ propose: "OFF", reason: "write_transport_not_armed" });
    }
  });

  it("ALL five absent ⇒ OFF, reason names the first-checked precondition (content trust)", () => {
    expect(
      gateProposeArming({
        contentTrustReal: false,
        proofSpineProvisioned: false,
        signingKeyResolved: false,
        writeTransportArmed: false,
        provenanceStampingReal: false,
      }),
    ).toEqual({ propose: "OFF", reason: "content_trust_not_real" });
  });
});

describe("gateProposeArming — boot call-site coverage (source pin: no lightweight runtime seam exists for the inline mappings — mirrors proposeArmingStrictEquality.test.ts's established methodology)", () => {
  it("proposeEnabled is AND-gated on proposeArming.propose === \"ON\"", () => {
    expect(bootSource).toMatch(
      /proposeEnabled:\s*proposeArming\.propose\s*===\s*"ON"\s*&&\s*config\.copilotProposeMode\s*===\s*true/,
    );
  });

  it("knowledgeProposeEnabled is AND-gated on proposeArming.propose === \"ON\"", () => {
    expect(bootSource).toMatch(
      /knowledgeProposeEnabled:\s*proposeArming\.propose\s*===\s*"ON"\s*&&\s*config\.copilotProposeKnowledge\s*===\s*true\s*&&\s*proofSpineParams\s*!==\s*undefined/,
    );
  });

  it("proposeArming is bound via a single gateProposeArming({...}) call site — not re-derived per mapping", () => {
    // ONE call site, not duplicated per flag: both mappings above reference the SAME `const proposeArming`.
    // (Textual position is NOT asserted here — `agentSynthesisFactory`'s thunk is a LAZY closure defined
    // earlier in the file whose body only EXECUTES per-ask, long after `proposeArming` is assigned; JS
    // closures over a later-declared `const` are safe once the closure is invoked after that point, so
    // source order is not the correctness property to pin.)
    const occurrences = bootSource.match(/const proposeArming = gateProposeArming\(\{/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("withProposeKnowledgeApproval's bind stays unconditional on proofSpineParams alone — the port existing is not itself the capability; the resolver mappings above are what gate the model-facing grant", () => {
    // Documents (does not newly assert) the deliberate lead-ruled shape this suite's header explains:
    // the port binds whenever `proofSpineParams !== undefined`, never on `proposeArming`. Isolate the
    // FUNCTION BODY (not just "somewhere in the file") so a stray unrelated `undefined` guard elsewhere
    // can't false-pass this pin — anchor on the function's own opening + its very next statement.
    const start = bootSource.indexOf("export function withProposeKnowledgeApproval(");
    expect(start).toBeGreaterThan(-1);
    const body = bootSource.slice(start, start + 400);
    // The guard is the function's FIRST statement, and it reads ONLY `proofSpineParams === undefined` —
    // no `proposeArming` term. A regression that re-gated this bind on `proposeArming` too would add an
    // `&&` here and RED this assertion (whitespace-tolerant, no `&&` permitted between the two clauses).
    expect(body).toMatch(
      /\{\s*if\s*\(\s*proofSpineParams\s*===\s*undefined\s*\)\s*return\s*undefined;/,
    );
    expect(body).not.toMatch(/proofSpineParams\s*===\s*undefined\s*&&/);
    expect(body).not.toContain("proposeArming");
  });
});
