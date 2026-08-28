// DOD-worker-boot task 1 — 24.62's durable-write half. `createAuditPersistPort` (boot.ts:782-855)
// gated the `AuditSignal` via `isRedactionSafe` before persisting, but persisted the caller-supplied
// `workspaceId` — `persistDenial`'s SECOND data channel — unscanned:
//   const record = { ...toAuditRecordInput(signal, deps.now()), workspaceId };
// The knowledge-side sibling (`persistDenialAudit`, `packages/knowledge/src/gcl/projection.ts`, task
// 24.62, `92595096`) closed the identical gap; both sinks then rode `auditFieldContainsSecret`
// (`packages/knowledge/src/knowledge-writer/secret-scan.ts`), the "would this be safe as an AUDIT
// FIELD?" predicate.
//
// ⛔ PREDICATE CORRECTED (task 24.130 deposit 2) — knowledge side at `c0909f98`, this side after it.
// BOTH sinks now use `@sow/domain`'s `looksLikeCredentialShape`: the same credential-SHAPE nets with
// `SENSITIVE_KEYWORD` excluded. A `workspaceId` is a human-chosen NAME, and the keyword arm refused
// `acme-credential-review` — an audit row lost to a WORD. The two implementations still agree; the
// agreement moved to the predicate that fits the field.
// ⚠ WHAT THAT MEANS FOR THIS SUITE: the three credential-SHAPE assertions below pass under BOTH
// predicates and therefore could not have detected the change. The `acme-credential-review` case is
// the only discriminator, and it was observed RED before the swap.
//
// SEVERITY, established by tracing rather than assumption: on the GCL path `signal.event` cannot carry
// non-literal content (see boot.ts:840-845's own call-path enumeration of `event`'s three reachable
// producers), so this gap is LATENT, not a live leak — a WIRING PRECONDITION on binding the GCL port at
// Phase 25.2/25.4 (the same "reachability-waivered" framing `persistDenialAudit`'s own header uses),
// never a fix for an in-production exploit.
import { describe, it, expect, vi } from "vitest";
import { isOk } from "@sow/contracts";
import type { AuditRecord } from "@sow/contracts";
import type { AuditRepository, AuditQuery, DbResult, DbError } from "@sow/db";
import { buildAuditSignal } from "@sow/policy";
import { createAuditPersistPort } from "../../src/boot";

const NOW = "2026-08-25T00:00:00.000Z";

/** A real-filtering in-memory AuditRepository, mirroring the existing 24.7/24.62 test helper shape
 *  (`apps/worker/test/api/procedures/copilotDenialAudit.test.ts`) — duplicated here rather than shared
 *  because that file sits outside this package's declared territory for this task. */
function memAuditQueryable(fault = false): { repo: AuditRepository; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const repo: AuditRepository = {
    append: (rec: AuditRecord): DbResult<void> => {
      if (fault) {
        return Promise.resolve({ ok: false, error: { code: "unavailable", message: "audit store down" } as DbError });
      }
      records.push(rec);
      return Promise.resolve({ ok: true, value: undefined });
    },
    query: (filter: AuditQuery, limit: number): DbResult<AuditRecord[]> => {
      const matched = records.filter(
        (r) =>
          (filter.actor === undefined || r.actor === filter.actor) &&
          (filter.event === undefined || r.event === filter.event) &&
          (filter.ref === undefined || r.refs.includes(filter.ref)) &&
          (filter.workspaceId === undefined || r.workspaceId === filter.workspaceId),
      );
      return Promise.resolve({ ok: true, value: matched.slice(0, limit) });
    },
  };
  return { repo, records };
}

// A signal whose own six `isRedactionSafe`-scanned fields are all clean — isolates the assertion to the
// SECOND, workspaceId channel (the signal itself must not be why a case refuses).
const safeSignal = buildAuditSignal({
  actor: "policy",
  event: "egress.denied",
  refs: ["ref:workspace:ws-safe"],
  payloadHash: "sha256:abc123",
  beforeSummary: "route not vetoed",
  afterSummary: "egress denied",
});

/** A workspace a person could legitimately name — carries the WORD "credential", carries no
 *  credential. Refused by the audit-granularity predicate, admitted by the identifier one. */
const KEYWORD_NAMED_WS = "acme-credential-review";

/** Capture `console.error` for the duration of one call; always restores. Non-string args are
 *  `JSON.stringify`d (not `String()`d) so a future structured-arg log line does not silently escape a
 *  `not.toContain` assertion — mirrors the existing 24.62 test file's own helper. */
async function captureConsoleError(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const render = (a: unknown): string => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)));
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => void lines.push(args.map(render).join(" ")));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("DOD-worker-boot 1 — createAuditPersistPort gates the workspaceId channel through looksLikeCredentialShape (24.62, predicate corrected by 24.130 deposit 2)", () => {
  it("REFUSES to persist when workspaceId is credential-shaped, even though the signal itself is redaction-safe", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const credentialShapedWorkspaceId = "sk-live-abcdef1234567890"; // matches CREDENTIAL_PREFIX's \bsk-[a-z0-9]

    await port.persistDenial(safeSignal, credentialShapedWorkspaceId);

    const queried = await mem.repo.query({ workspaceId: credentialShapedWorkspaceId }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0); // refused, not persisted
  });

  it("REFUSES a second, distinct credential shape too (URL-userinfo), proving this is a real gate not a one-pattern coincidence", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const userinfoWorkspaceId = "//user:hunter2@internal-host"; // matches URL_USERINFO_CREDENTIAL

    await port.persistDenial(safeSignal, userinfoWorkspaceId);

    const queried = await mem.repo.query({ workspaceId: userinfoWorkspaceId }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0);
  });

  it("a workspace NAMED for credential work still persists — the availability half of 24.130 deposit 2", async () => {
    // ⛔ THIS IS THE ASSERTION THE PREDICATE SWAP EXISTS FOR, and it went RED before the swap.
    // A workspaceId is a HUMAN-CHOSEN NAME, not a machine-generated audit ref. Under the
    // audit-granularity predicate (`auditFieldContainsSecret`, `SENSITIVE_KEYWORD` included) a
    // person who names their workspace `acme-credential-review` loses the audit row entirely —
    // a refusal caused by the WORD, with no credential anywhere in it.
    // The identifier-granularity predicate (`looksLikeCredentialShape`, shape nets only) admits
    // it. The knowledge-side sibling `persistDenialAudit` was corrected the same way at
    // `c0909f98`; this closes 24.130's remaining "#2's WIRING AT THE WORKER SINK".
    // ⚠ The three shape assertions in this file all pass under BOTH predicates, so none of them
    // could detect this change. This one is the discriminator.
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });

    await port.persistDenial(safeSignal, KEYWORD_NAMED_WS);

    const queried = await mem.repo.query({ workspaceId: KEYWORD_NAMED_WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      expect(queried.value.length).toBe(1);
      expect(queried.value[0]?.workspaceId).toBe(KEYWORD_NAMED_WS);
    }
  });

  it("a non-credential-shaped workspaceId still persists — the gate discriminates, it does not deny-all (non-vacuity control)", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const ORDINARY_WS = "ws-employer-audit";

    await port.persistDenial(safeSignal, ORDINARY_WS);

    const queried = await mem.repo.query({ workspaceId: ORDINARY_WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      expect(queried.value.length).toBe(1);
      expect(queried.value[0]?.workspaceId).toBe(ORDINARY_WS);
    }
  });

  it("the refusal notice names the tripped channel as the field NAME 'workspaceId' (a closed literal) and never the credential VALUE (rule 7)", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const SECRET_WS = "AKIA1234567890ABCDEF"; // matches CREDENTIAL_PREFIX's AKIA[0-9A-Z]{16}

    const lines = await captureConsoleError(() => port.persistDenial(safeSignal, SECRET_WS));

    expect(lines.length).toBe(1);
    const notice = lines.join("\n");
    expect(notice).toContain("REFUSED");
    expect(notice).toContain("workspaceId"); // POSITIVE: the channel NAME appears
    expect(notice).not.toContain(SECRET_WS); // NEGATIVE: the tripped VALUE never does
  });
});
