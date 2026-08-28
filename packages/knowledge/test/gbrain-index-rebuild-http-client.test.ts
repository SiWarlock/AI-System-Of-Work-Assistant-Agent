// spec(§6) — the GbrainHttpIndexRebuildClient write-side HTTP transport over `gbrain serve --http`'s
// wholesale-replace rebuild surface (task 19.7). Dormant/unbound: tested ENTIRELY with a FAKE
// HttpTransport + FAKE SecretsAccessor — zero real network/process/Keychain. Mirrors the read/apply
// clients' guard order (canonical-target guard FIRST, then SSRF/allowlist, then secret resolution,
// Lesson 1) and NEVER throws across `rebuildFromMarkdown` — every failure folds into a typed
// `IndexRebuildError`. A dedicated integration block drives the REAL `rebuildIndexFromMarkdown`
// (rebuild.ts) over this client to prove the client's honesty (relaying the server's real counts) is
// what lets `incomplete_recovery` actually fire.
import { describe, it, expect } from "vitest";
import { HealthItemSchema, ok, err, isOk, isErr, workspaceId } from "@sow/contracts";
import type { RevisionId, Result, BrainId } from "@sow/contracts";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { deriveCanonicalFacts } from "../src/gbrain/derive/canonical-fact-deriver";
import type { CanonicalVaultSnapshot } from "../src/gbrain/derive/canonical-fact-deriver";
import { rebuildIndexFromMarkdown } from "../src/gbrain/rebuild";
import type { IndexRebuildRequest, IndexRebuildError, RebuildDeps } from "../src/gbrain/rebuild";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/gbrain/gbrain-http-read-client";
import {
  createGbrainHttpIndexRebuildClient,
  type GbrainHttpIndexRebuildClientDeps,
} from "../src/gbrain/index-rebuild-http-client";

const TOKEN = "gb-secret-token-XYZ";
const TOKEN_REF = "keychain:gbrain-token";
const LOOPBACK = "http://127.0.0.1:8899";
// 24.92: a real branded constructor — "ws-rebuild" is a benign fixture id, no anonymous cast needed.
const WS = workspaceId("ws-rebuild");
const SCRATCH = "brain-scratch-1" as BrainId;
const CANONICAL = "brain-canonical-1" as BrainId;
const NOW = "2026-07-01T00:00:00.000Z";

// ── fixtures ────────────────────────────────────────────────────────────────

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  const map = new Map(Object.entries(files));
  return { workspaceId: WS, revisionId: computeRevisionId(map) as RevisionId, files: map };
}

const twoPages = () =>
  snapshot({
    "alpha.md": "# Alpha\n\nLinks to [[beta]].\n",
    "beta.md": "---\ntags: work\n---\n# Beta\n\nBody.\n",
  });

function rebuildRequestFor(snap: CanonicalVaultSnapshot): IndexRebuildRequest {
  const derived = deriveCanonicalFacts(snap);
  if (!derived.ok) throw new Error("fixture derive failed");
  return {
    workspaceId: snap.workspaceId as string,
    revisionId: snap.revisionId as string,
    facts: derived.value.facts,
  };
}

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return (
        behavior.response ?? { status: 200, body: JSON.stringify({ nodeCount: 0, replaced: true }) }
      );
    },
  };
}

function fakeSecrets(
  result: Result<string, SecretUnavailable> = ok(TOKEN),
): SecretsAccessor & { refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    async getSecret(ref) {
      refs.push(ref);
      return result;
    },
  };
}

function makeDeps(
  overrides: Partial<GbrainHttpIndexRebuildClientDeps> = {},
): GbrainHttpIndexRebuildClientDeps {
  return {
    transport: fakeTransport(),
    secrets: fakeSecrets(),
    tokenRef: TOKEN_REF,
    endpoint: LOOPBACK,
    allowedEndpoints: [LOOPBACK],
    scratchBrainId: SCRATCH,
    canonicalBrainId: CANONICAL,
    ...overrides,
  };
}

function dumpRebuildError(e: IndexRebuildError): string {
  const own = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const cause = e.cause;
  const causeDump =
    cause instanceof Error
      ? `${cause.message} ${String((cause as { stack?: unknown }).stack ?? "")} ${JSON.stringify(
          cause,
          Object.getOwnPropertyNames(cause),
        )}`
      : cause !== undefined
        ? JSON.stringify(cause)
        : "";
  return `${own} ${causeDump}`;
}

async function neverRejects<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw new Error(`expected rebuildFromMarkdown to resolve (never reject), but it rejected: ${String(e)}`);
  });
}

// ── (a) canonical-target guard runs before ANY I/O ────────────────────────────

describe("createGbrainHttpIndexRebuildClient — scratch-only guard (safety rule 1)", () => {
  it("canonical_brain_target_is_refused_before_dispatch", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const client = createGbrainHttpIndexRebuildClient(
      makeDeps({ transport, secrets, scratchBrainId: CANONICAL, canonicalBrainId: CANONICAL }),
    );
    const request = rebuildRequestFor(twoPages());
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("rebuild_failed");
    expect(secrets.refs).toHaveLength(0); // ZERO secret reads
    expect(transport.calls).toHaveLength(0); // ZERO dispatch
  });

  it("a_distinct_scratch_target_dispatches_normally", async () => {
    // Non-vacuity control for the guard above: a GENUINELY distinct scratch id must NOT be refused.
    const transport = fakeTransport({ response: { status: 200, body: JSON.stringify({ nodeCount: 2, replaced: true }) } });
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport }));
    const request = rebuildRequestFor(twoPages());
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isOk(result)).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });
});

// ── (b) SSRF/allowlist before secrets ─────────────────────────────────────────

describe("createGbrainHttpIndexRebuildClient — guard order (Lesson 1 / Lesson 4)", () => {
  it("off_allowlist_endpoint_refuses_before_secret_read", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const client = createGbrainHttpIndexRebuildClient(
      makeDeps({ transport, secrets, endpoint: LOOPBACK, allowedEndpoints: ["http://127.0.0.1:1234"] }),
    );
    const request = rebuildRequestFor(twoPages());
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("gbrain_unavailable");
    expect(secrets.refs).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("token_unavailable_never_dispatches", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets(err({ reason: "locked" }));
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport, secrets }));
    const request = rebuildRequestFor(twoPages());
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("gbrain_unavailable");
    expect(transport.calls).toHaveLength(0);
  });
});

// ── (d) never throws on transport rejection ───────────────────────────────────

describe("createGbrainHttpIndexRebuildClient — redacted fold, never throws (§16)", () => {
  it("a_transport_rejection_folds_to_a_typed_result_never_a_rejected_promise", async () => {
    const transport = fakeTransport({ throw: new Error(`ECONNREFUSED ${LOOPBACK}`) });
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport }));
    const request = rebuildRequestFor(twoPages());
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("gbrain_unavailable");
  });

  it("non_2xx_and_malformed_body_fold_to_rebuild_failed", async () => {
    const nonTwoXx = fakeTransport({ response: { status: 500, body: "{}" } });
    const clientA = createGbrainHttpIndexRebuildClient(makeDeps({ transport: nonTwoXx }));
    const resultA = await neverRejects(clientA.rebuildFromMarkdown(rebuildRequestFor(twoPages())));
    expect(isErr(resultA)).toBe(true);
    if (isErr(resultA)) expect(resultA.error.code).toBe("rebuild_failed");

    const malformed = fakeTransport({ response: { status: 200, body: "<<not json>>" } });
    const clientB = createGbrainHttpIndexRebuildClient(makeDeps({ transport: malformed }));
    const resultB = await neverRejects(clientB.rebuildFromMarkdown(rebuildRequestFor(twoPages())));
    expect(isErr(resultB)).toBe(true);
    if (isErr(resultB)) expect(resultB.error.code).toBe("rebuild_failed");
  });
});

// ── redaction (rule 7) ─────────────────────────────────────────────────────────

describe("createGbrainHttpIndexRebuildClient — redacted fault mapping (rule 7)", () => {
  it("fault_message_carries_no_token_no_url_no_row_content", async () => {
    const sentinel = "SENTINEL-ROW-CONTENT-9f3a2b1c";
    const snap = snapshot({ "leak.md": `# Leak\n\n${sentinel}\n` });
    const request = rebuildRequestFor(snap);
    const secrets = fakeSecrets();
    const transport: HttpTransport = {
      async send() {
        throw new Error(`ECONNREFUSED ${LOOPBACK} token=${TOKEN} body=${sentinel}`);
      },
    };
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport, secrets }));
    const result = await neverRejects(client.rebuildFromMarkdown(request));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    // pin the fault fired for the intended reason (transport throw), not e.g. a redacted
    // rebuild_failed from a different branch — the union has more than one code.
    expect(result.error.code).toBe("gbrain_unavailable");
    const dump = dumpRebuildError(result.error);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(sentinel);
    expect(dump).not.toContain(LOOPBACK);
  });
});

// ── (c) integration: honesty over the REAL rebuildIndexFromMarkdown ──────────

function rebuildDeps(overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    // placeholder, replaced per-test with the real client
    rebuildClient: { async rebuildFromMarkdown() { throw new Error("unset"); } },
    now: () => NOW,
    newHealthItemId: () => "health-rebuild-http-1",
    auditRef: "audit-rebuild-http-1",
    ...overrides,
  };
}

describe("createGbrainHttpIndexRebuildClient — honesty drives rebuildIndexFromMarkdown's fail-closed legs", () => {
  it("a_partial_replace_reports_the_real_recovered_count_not_the_expected_one", async () => {
    const snap = twoPages();
    const derived = deriveCanonicalFacts(snap);
    if (!derived.ok) throw new Error("fixture derive failed");
    const expectedCount = derived.value.facts.length;
    expect(expectedCount).toBeGreaterThan(1); // non-vacuity: there IS a gap to under-report

    // The fake server under-reports nodeCount (fewer than what's derivable) — the client must relay
    // that SMALLER number honestly, which is what lets rebuildIndexFromMarkdown's own
    // recovery-completeness check (nodeCount !== facts.length) actually fire.
    const transport = fakeTransport({
      response: { status: 200, body: JSON.stringify({ nodeCount: expectedCount - 1, replaced: true }) },
    });
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport }));

    const outcome = await rebuildIndexFromMarkdown(snap, rebuildDeps({ rebuildClient: client }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("incomplete_recovery"); // never a false green
    if (outcome.error.code === "incomplete_recovery") {
      expect(outcome.error.expected).toBe(expectedCount);
      expect(outcome.error.recovered).toBe(expectedCount - 1);
    }
    const health = HealthItemSchema.safeParse(outcome.error.healthItem);
    expect(health.success).toBe(true); // the distinct rebuild_divergence item is well-formed
  });

  it("a_full_and_honestly_replaced_rebuild_succeeds_end_to_end", async () => {
    // Non-vacuity control for the case above: an HONEST full report succeeds.
    const snap = twoPages();
    const derived = deriveCanonicalFacts(snap);
    if (!derived.ok) throw new Error("fixture derive failed");
    const transport = fakeTransport({
      response: { status: 200, body: JSON.stringify({ nodeCount: derived.value.facts.length, replaced: true }) },
    });
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport }));

    const outcome = await rebuildIndexFromMarkdown(snap, rebuildDeps({ rebuildClient: client }));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.recoveredNodeCount).toBe(derived.value.facts.length);
      expect(outcome.value.receipt.replaced).toBe(true);
    }
  });

  it("a_non_replacing_report_is_relayed_honestly_and_rejected_by_the_real_gate", async () => {
    // The server reports replaced:false — the client must NOT coerce this to true; the real
    // rebuildIndexFromMarkdown gate rejects it as non_replacing_rebuild.
    const snap = twoPages();
    const derived = deriveCanonicalFacts(snap);
    if (!derived.ok) throw new Error("fixture derive failed");
    const transport = fakeTransport({
      response: { status: 200, body: JSON.stringify({ nodeCount: derived.value.facts.length, replaced: false }) },
    });
    const client = createGbrainHttpIndexRebuildClient(makeDeps({ transport }));

    const outcome = await rebuildIndexFromMarkdown(snap, rebuildDeps({ rebuildClient: client }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("non_replacing_rebuild");
  });
});
