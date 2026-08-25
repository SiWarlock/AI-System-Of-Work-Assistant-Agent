import { describe, it, expect, expectTypeOf } from "vitest";
import {
  workspaceId,
  agentJobId,
  approvalId,
  InvalidIdError,
  type WorkspaceId,
  type AgentJobId,
} from "../src/primitives/ids";
import {
  WorkspaceType,
  DataOwner,
  VisibilityLevel,
  ProviderId,
  EgressClass,
  isWorkspaceType,
  isProviderId,
  processorId,
  toolId,
} from "../src/primitives/enums";
import { ok, err, isOk, isErr, type Result } from "../src/primitives/result";
import { EventName, isEventName } from "../src/events/catalog";

describe("branded ID constructors (1.1)", () => {
  it("accepts a non-empty string and returns the branded value", () => {
    expect(workspaceId("ws-employer")).toBe("ws-employer");
  });

  it("rejects empty / whitespace-only with a typed InvalidIdError", () => {
    expect(() => workspaceId("")).toThrowError(InvalidIdError);
    expect(() => workspaceId("   ")).toThrowError(InvalidIdError);
    expect(() => agentJobId("\t\n")).toThrowError(InvalidIdError);
  });

  // ### 24.100 — `makeId` casts without ever running the brand's own schema:
  // it was a non-empty check + a bare cast, so anything non-blank passed
  // regardless of shape. `WorkspaceIdSchema` has carried a NARROWER
  // well-formedness shape since `### 24.84` (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`,
  // max 64), but `workspaceId()` never invoked it — this is the defect,
  // pinned directly against the public constructor (not the schema, which
  // already had its own coverage in `zod-brands.test.ts`).
  it("rejects a non-empty but malformed workspace id — the constructor now RUNS WorkspaceIdSchema (### 24.100)", () => {
    expect(() => workspaceId("NOT a valid workspace id!!")).toThrowError(InvalidIdError);
  });

  it("still accepts every well-formed slug-shaped workspace id (### 24.100 non-regression)", () => {
    expect(workspaceId("employer-work")).toBe("employer-work");
    expect(workspaceId("ws-1")).toBe("ws-1");
  });

  it("the error carries the id type + raw value for diagnostics", () => {
    try {
      approvalId("");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidIdError);
      expect((e as InvalidIdError).idType).toBe("ApprovalId");
    }
  });

  it("brands are not cross-assignable at compile time", () => {
    const w: WorkspaceId = workspaceId("ws-1");
    expectTypeOf(w).not.toMatchTypeOf<AgentJobId>();
  });
});

describe("shared enums (1.1)", () => {
  it("pin exact literal membership", () => {
    expect([...WorkspaceType]).toEqual([
      "employer_work",
      "personal_business",
      "personal_life",
    ]);
    expect([...DataOwner]).toEqual(["employer", "user", "client"]);
    expect([...VisibilityLevel]).toEqual([
      "isolated",
      "coordination",
      "sanitized",
      "full",
    ]);
    expect([...ProviderId]).toEqual([
      "claude",
      "openai",
      "openrouter",
      "ollama",
      "lm_studio",
      // 13.13 research providers (additive, each its OWN member — rule 5 no-alias).
      "perplexity",
      "xai",
    ]);
    expect([...EgressClass]).toEqual(["local", "cloud"]);
  });

  it("guards reject non-members", () => {
    expect(isWorkspaceType("employer_work")).toBe(true);
    expect(isWorkspaceType("nope")).toBe(false);
    expect(isProviderId("openrouter")).toBe(true);
    expect(isProviderId("gemini")).toBe(false);
  });

  it("ProcessorId / ToolId are branded string constructors (catalogs upstream-open)", () => {
    expect(processorId("anthropic")).toBe("anthropic");
    expect(toolId("calendar.create")).toBe("calendar.create");
    expect(() => processorId("")).toThrowError(InvalidIdError);
  });
});

describe("Result<T,E> envelope (1.1)", () => {
  it("ok/err discriminate without throwing", () => {
    const good: Result<number, string> = ok(42);
    const bad: Result<number, string> = err("boom");
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error).toBe("boom");
  });
});

describe("event-name catalog (1.1)", () => {
  it("is the single const-union source for the §10 push stream", () => {
    expect([...EventName]).toEqual([
      "workflow.status",
      "approval.update",
      "system.health",
      "read_model.change",
    ]);
    expect(isEventName("approval.update")).toBe(true);
    expect(isEventName("secret.leak")).toBe(false);
  });
});
