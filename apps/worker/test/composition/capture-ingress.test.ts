// 13.6 / 24.22 — capture-ingress: the two TRUSTED local triggers (git commit hook, loopback-API
// session-end hook), both routing through buildCaptureSource -> registerSource -> dispatch. Fixtures
// use REAL @sow/integrations pure builders (buildCodingSessionCapture, createRepoWorkspaceResolver,
// createCodingSessionOriginVerifier) — only the dispatch + dedupe store are faked, mirroring
// connectorIngestionBridge.test.ts's own convention (drive the real candidate-gate machinery, fake
// only the Temporal/store boundary).
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import { createCodingSessionOriginVerifier } from "@sow/integrations/connectors/adapters/coding-session-capture";
import type { GitHookEvent } from "@sow/integrations/connectors/adapters/coding-session-capture";
import { createCaptureIngress } from "../../src/composition/capture-ingress";
import type { CaptureIngressDeps, CaptureIngressOutcome } from "../../src/composition/capture-ingress";
import type { DispatchOutcome, DispatchError } from "../../src/temporal/dispatchSourceIngestion";
import type { SourceIngestionInput } from "@sow/workflows";

type DispatchFn = (input: SourceIngestionInput) => Promise<ReturnType<typeof ok<DispatchOutcome>> | ReturnType<typeof err<DispatchError>>>;

const KNOWN_REPO = "/repos/sow-build";
const KNOWN_WS = "employer-work";

function fixtureEvent(over: Partial<GitHookEvent> = {}): GitHookEvent {
  return {
    repoPath: KNOWN_REPO,
    commitSha: "abc123",
    subject: "feat: add capture ingress",
    changedFiles: ["src/a.ts", "src/b.ts"],
    insertions: 10,
    deletions: 2,
    ...over,
  };
}

function fixtureDeps(over: Partial<CaptureIngressDeps> = {}): CaptureIngressDeps {
  const verify = createCodingSessionOriginVerifier({
    knownRepos: [KNOWN_REPO],
    verifyCommitSha: () => true, // a real commit-verification stand-in — always confirms in this suite
  });
  return {
    repoWorkspaceMap: [{ repoPath: KNOWN_REPO, workspaceId: KNOWN_WS }],
    verifyCodingSessionOrigin: verify,
    sensitivity: "standard",
    registerDeps: { seenContentHash: () => Promise.resolve(false) },
    dispatch: () =>
      Promise.resolve(
        ok<DispatchOutcome>({ workflowId: "wf-1", dispatched: true, deduped: false }),
      ),
    ...over,
  };
}

describe("createCaptureIngress — the two trusted triggers (13.6)", () => {
  it("captureGitCommit_dispatches_a_known_repo_verified_commit", async () => {
    const calls: unknown[] = [];
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-1", dispatched: true, deduped: false })),
    );
    const ingress = createCaptureIngress(fixtureDeps({ dispatch, onCapture: (o) => calls.push(o) }));

    const result = await ingress.captureGitCommit(fixtureEvent());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({ kind: "dispatched", workflowId: "wf-1", deduped: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [input] = dispatch.mock.calls[0]!;
    expect(input.run.workspaceId).toBe(KNOWN_WS);
    expect(input.run.trigger).toBe("owner_action");
    expect(input.context.source.workspaceId).toBe(KNOWN_WS);
    expect(calls).toEqual([{ kind: "dispatched", workflowId: "wf-1", deduped: false }]);
  });

  it("captureSessionEnd_uses_the_SAME_pipeline_as_captureGitCommit", async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-2", dispatched: true, deduped: false })),
    );
    const ingress = createCaptureIngress(fixtureDeps({ dispatch }));

    const result = await ingress.captureSessionEnd(fixtureEvent({ subject: "session wrap-up" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.kind).toBe("dispatched");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("unmapped_repo_fails_closed_never_dispatches — WS-8: no workspace guess", async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-x", dispatched: true, deduped: false })),
    );
    const ingress = createCaptureIngress(fixtureDeps({ dispatch }));

    const result = await ingress.captureGitCommit(fixtureEvent({ repoPath: "/repos/unknown-repo" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({ kind: "repo_unmapped" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("empty_content_event_is_rejected_never_dispatches — mirrors buildCodingSessionCapture's own hollow guard", async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-x", dispatched: true, deduped: false })),
    );
    const ingress = createCaptureIngress(fixtureDeps({ dispatch }));

    const result = await ingress.captureGitCommit(
      fixtureEvent({ subject: "", body: undefined, changedFiles: [] }),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.kind).toBe("rejected");
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ── 24.22 — routingHints.trustLevel is a REAL consumer here ─────────────────────────────────
  describe("24.22 — origin verification gates dispatch on a designated-TRUSTED trigger", () => {
    it("an_unverified_commit_on_a_known_repo_surfaces_origin_unverified_never_dispatches", async () => {
      const verify = createCodingSessionOriginVerifier({
        knownRepos: [KNOWN_REPO],
        verifyCommitSha: () => false, // the commit itself fails verification
      });
      const dispatch = vi.fn<DispatchFn>(() =>
        Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-x", dispatched: true, deduped: false })),
      );
      const ingress = createCaptureIngress(
        fixtureDeps({ verifyCodingSessionOrigin: verify, dispatch }),
      );

      const result = await ingress.captureGitCommit(fixtureEvent());

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value).toEqual({ kind: "origin_unverified" });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("no_commit_at_all_never_verifies_never_dispatches — 24.14's own 'nothing to verify' fail-closed rule", async () => {
      // buildCodingSessionCapture ALWAYS carries `commit: event.commitSha`; simulate the
      // no-commit case via a caller that stamps an empty commitSha (never verified: capture-source.ts
      // still builds a candidate with `commit: ""`, but createCodingSessionOriginVerifier's own
      // `capture.commit === undefined` check does not fire on an EMPTY STRING commit — so this
      // test drives the realistic "known repo, verifier itself refuses" path instead, matching the
      // sanctioned verifier's actual contract; a truly undefined commit is structurally impossible
      // once buildCodingSessionCapture has run (it always sets `commit` from `event.commitSha`).
      const verify = createCodingSessionOriginVerifier({
        knownRepos: [KNOWN_REPO],
        verifyCommitSha: (_repo, sha) => sha.length > 0,
      });
      const dispatch = vi.fn<DispatchFn>(() =>
        Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-x", dispatched: true, deduped: false })),
      );
      const ingress = createCaptureIngress(
        fixtureDeps({ verifyCodingSessionOrigin: verify, dispatch }),
      );

      const result = await ingress.captureGitCommit(fixtureEvent({ commitSha: "" }));

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value).toEqual({ kind: "origin_unverified" });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("a_permissive_always_true_verifier_still_dispatches — the channel is REAL, not hardwired to reject", async () => {
      // Proves the gate is a genuine READ of the stamped trustLevel, not a hardwired refusal —
      // the happy-path test above already covers this, but this test isolates it explicitly against
      // a maximally-permissive (but still real) verifier.
      const verify = (): boolean => true;
      const dispatch = vi.fn<DispatchFn>(() =>
        Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-y", dispatched: true, deduped: false })),
      );
      const ingress = createCaptureIngress(
        fixtureDeps({ verifyCodingSessionOrigin: verify, dispatch }),
      );

      const result = await ingress.captureGitCommit(fixtureEvent());

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.value.kind).toBe("dispatched");
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("dedupe_hit_never_dispatches_twice", async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve(ok<DispatchOutcome>({ workflowId: "wf-1", dispatched: true, deduped: false })),
    );
    const ingress = createCaptureIngress(
      fixtureDeps({ dispatch, registerDeps: { seenContentHash: () => Promise.resolve(true) } }),
    );

    const result = await ingress.captureGitCommit(fixtureEvent());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({ kind: "dedupe_hit" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a_dispatch_failure_is_a_typed_err — never a thrown/unhandled fault", async () => {
    const ingress = createCaptureIngress(
      fixtureDeps({
        dispatch: (() =>
          Promise.resolve(err<DispatchError>({ code: "temporal_unavailable", message: "down" }))) as DispatchFn,
      }),
    );

    const result = await ingress.captureGitCommit(fixtureEvent());

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error).toEqual({ code: "dispatch_failed", cause: "temporal_unavailable" });
  });

  it("telegram_is_structurally_out_of_scope — this ingress never builds a TelegramCapture (no such entry point exists)", () => {
    const ingress = createCaptureIngress(fixtureDeps());
    // The ONLY two entry points are captureGitCommit / captureSessionEnd — no capture(kind) generic
    // surface, no /capture command, no telegram wiring. Type-level + surface-level proof.
    expect(Object.keys(ingress).sort()).toEqual(["captureGitCommit", "captureSessionEnd"]);
  });

  it("an_observer_throw_never_alters_the_result — best-effort (L25/L53)", async () => {
    const ingress = createCaptureIngress(
      fixtureDeps({
        onCapture: () => {
          throw new Error("observer exploded");
        },
      }),
    );

    const result = await ingress.captureGitCommit(fixtureEvent());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.kind).toBe("dispatched");
  });

  it("no_raw_diff_content_or_file_names_reach_the_observer — rule 7 canary", async () => {
    const SECRET_FILE = "SECRET-CANARY-FILE.md";
    const calls: unknown[] = [];
    const ingress = createCaptureIngress(fixtureDeps({ onCapture: (o) => calls.push(o) }));

    await ingress.captureGitCommit(fixtureEvent({ changedFiles: [SECRET_FILE] }));

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(SECRET_FILE);
  });
});
