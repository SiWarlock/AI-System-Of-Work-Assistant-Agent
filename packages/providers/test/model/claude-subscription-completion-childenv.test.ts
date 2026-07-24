// 18.40 — the rule-5 completeness forward: the (armed) worker supplies a minimal `childEnv`; this thin providers
// boundary passes it as the SDK `query()` `options.env` (which REPLACES the child env entirely), else omits it
// (byte-equivalent inherit). The completion I/O boundary is otherwise integration/eval-tested (the SDK import is
// mocked here ONLY to capture the forwarded options — the mapping logic lives in the pure `extractCompletion`).
import { describe, it, expect, vi, beforeEach } from "vitest";

interface CapturedQuery {
  readonly options?: { readonly env?: Record<string, string | undefined> };
}
let captured: CapturedQuery | undefined;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  // Capture the args, then return an empty async iterable — we only assert the forwarded `options.env`; the
  // completion's own mapping (extractCompletion over []) is not under test here.
  query: (args: CapturedQuery) => {
    captured = args;
    return (async function* () {
      /* yield nothing */
    })();
  },
}));

import {
  createClaudeSubscriptionCompletion,
  type CompletionRequest,
} from "../../src/model/claude-subscription-completion";

const req: CompletionRequest = {
  model: "claude-x",
  systemPrompt: "sys",
  userPrompt: "usr",
  outputSchema: { type: "object" },
};

describe("createClaudeSubscriptionCompletion — 18.40 childEnv → options.env forward (rule-5 completeness)", () => {
  beforeEach(() => {
    captured = undefined;
  });

  it("forwards childEnv to options.env when supplied — the child sees ONLY the minimal allowlist", async () => {
    const childEnv = { PATH: "/usr/bin", HOME: "/Users/op" };
    await createClaudeSubscriptionCompletion({ childEnv }).complete(req);
    expect(captured?.options?.env).toEqual(childEnv);
  });

  it("omits options.env when childEnv absent — byte-equivalent inherit (shipped default unchanged)", async () => {
    await createClaudeSubscriptionCompletion().complete(req);
    expect(captured?.options).toBeDefined();
    expect(captured?.options).not.toHaveProperty("env");
  });
});
