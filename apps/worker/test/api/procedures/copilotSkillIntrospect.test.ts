// Skill-B — the skill self-introspection handler (§13.10d): list_skills / get_skill over the STATIC read
// catalog. It touches NO workspace data (no brain, no vault), so there is no scope to bind and no leak to
// guard — the whole point of the `workspace-agnostic` class. Two invariants beyond "returns the catalog":
// (1) it NEVER enumerates or reveals the write-PROPOSING tool (an untrusted agent must not even be told it
// exists — minimizes prompt-injection steering); (2) it never throws + fails closed to a safe empty result.
import { describe, it, expect } from "vitest";
import { toolId } from "@sow/contracts";
import { COPILOT_READ_TOOLS, COPILOT_PROPOSE_TOOL, copilotToolScopingClass } from "@sow/policy";
import { handleCopilotSkillIntrospect } from "../../../src/api/procedures/copilotSkillIntrospect";

/** Parse the single text block of the MCP envelope back to its JSON payload. */
function payloadOf(r: { content: ReadonlyArray<{ type: "text"; text: string }> }): unknown {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe("text");
  return JSON.parse(r.content[0]!.text);
}

interface SkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly scoping: string;
}

describe("handleCopilotSkillIntrospect — list_skills", () => {
  it("enumerates EVERY read-catalog skill with id + description + mutating:false + scoping class", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("list", {})) as { skills: SkillDescriptor[] };
    expect(Array.isArray(payload.skills)).toBe(true);
    // exact 1:1 with the read catalog (count + per-entry projection)
    expect(payload.skills).toHaveLength(COPILOT_READ_TOOLS.length);
    for (const spec of COPILOT_READ_TOOLS) {
      const got = payload.skills.find((s) => s.id === String(spec.id));
      expect(got, `missing skill ${String(spec.id)}`).toBeDefined();
      expect(got!.description).toBe(spec.description);
      expect(got!.mutating).toBe(false);
      expect(got!.scoping).toBe(copilotToolScopingClass(spec.id));
    }
    // spot-check representative ids across classes + the self-referential introspection tools
    const ids = payload.skills.map((s) => s.id);
    expect(ids).toContain("gbrain.search");
    expect(ids).toContain("vault.read");
    expect(ids).toContain("skills.list");
    expect(ids).toContain("skills.get");
  });

  it("NEVER enumerates the write-PROPOSING tool (an untrusted agent isn't told it exists)", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("list", {})) as { skills: SkillDescriptor[] };
    const ids = payload.skills.map((s) => s.id);
    expect(ids).not.toContain(String(COPILOT_PROPOSE_TOOL.id));
    expect(ids).not.toContain("copilot.propose_action");
    // and nothing mutating rides in
    expect(payload.skills.every((s) => s.mutating === false)).toBe(true);
  });

  it("ignores args entirely (list takes no input) — a malformed args value still lists", async () => {
    for (const args of [undefined, null, "junk", { anything: 1 }, 42]) {
      const payload = payloadOf(await handleCopilotSkillIntrospect("list", args)) as { skills: SkillDescriptor[] };
      expect(payload.skills.length).toBe(COPILOT_READ_TOOLS.length);
    }
  });
});

describe("handleCopilotSkillIntrospect — get_skill", () => {
  it("returns one read-skill's metadata by id", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("get", { id: "gbrain.search" })) as {
      skill: SkillDescriptor | null;
    };
    expect(payload.skill).not.toBeNull();
    expect(payload.skill!.id).toBe("gbrain.search");
    expect(payload.skill!.mutating).toBe(false);
    expect(payload.skill!.scoping).toBe(copilotToolScopingClass(toolId("gbrain.search")));
  });

  it("returns its OWN metadata (self-introspection is honest, not circular)", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("get", { id: "skills.get" })) as {
      skill: SkillDescriptor | null;
    };
    expect(payload.skill!.id).toBe("skills.get");
    expect(payload.skill!.scoping).toBe("workspace-agnostic");
  });

  it("returns {skill:null} for the write-PROPOSING tool — never reveals it via get either", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("get", { id: "copilot.propose_action" })) as {
      skill: SkillDescriptor | null;
    };
    expect(payload.skill).toBeNull();
  });

  it("returns {skill:null} for an unknown id", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("get", { id: "gbrain.some_new_tool" })) as {
      skill: SkillDescriptor | null;
    };
    expect(payload.skill).toBeNull();
  });

  it("returns {skill:null} for malformed args (no id / non-string id / non-object)", async () => {
    for (const args of [{}, { id: 42 }, { id: "" }, null, "gbrain.search", 7]) {
      const payload = payloadOf(await handleCopilotSkillIntrospect("get", args)) as {
        skill: SkillDescriptor | null;
      };
      expect(payload.skill).toBeNull();
    }
  });
});

describe("handleCopilotSkillIntrospect — robustness", () => {
  it("an unknown op fails closed to a safe empty list (never throws)", async () => {
    const payload = payloadOf(await handleCopilotSkillIntrospect("bogus_op", {})) as { skills: SkillDescriptor[] };
    expect(payload.skills).toEqual([]);
  });

  it("always returns a well-formed single-text-block MCP envelope", async () => {
    for (const [op, args] of [
      ["list", {}],
      ["get", { id: "vault.read" }],
      ["get", { id: "nope" }],
      ["bogus", null],
    ] as const) {
      const r = await handleCopilotSkillIntrospect(op, args);
      expect(r.content).toHaveLength(1);
      expect(r.content[0]!.type).toBe("text");
      expect(() => JSON.parse(r.content[0]!.text)).not.toThrow();
    }
  });
});
