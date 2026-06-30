// Shared enums with exact literal membership (1.1). Const tuples are the single
// source of the literal set; the matching union type is derived from the tuple.
import { type Branded, makeId } from "./ids";

export const WorkspaceType = ["employer_work", "personal_business", "personal_life"] as const;
export type WorkspaceType = (typeof WorkspaceType)[number];

export const DataOwner = ["employer", "user", "client"] as const;
export type DataOwner = (typeof DataOwner)[number];

export const VisibilityLevel = ["isolated", "coordination", "sanitized", "full"] as const;
export type VisibilityLevel = (typeof VisibilityLevel)[number];

export const ProviderId = ["claude", "openai", "openrouter", "ollama", "lm_studio"] as const;
export type ProviderId = (typeof ProviderId)[number];

export const EgressClass = ["local", "cloud"] as const;
export type EgressClass = (typeof EgressClass)[number];

const member =
  <const T extends readonly string[]>(set: T) =>
  (v: unknown): v is T[number] =>
    typeof v === "string" && (set as readonly string[]).includes(v);

export const isWorkspaceType = member(WorkspaceType);
export const isDataOwner = member(DataOwner);
export const isVisibilityLevel = member(VisibilityLevel);
export const isProviderId = member(ProviderId);
export const isEgressClass = member(EgressClass);

// ProcessorId / ToolId are branded strings — the concrete catalogs are
// unspecified upstream (arch_gaps); validated for non-emptiness only here.
export type ProcessorId = Branded<string, "ProcessorId">;
export type ToolId = Branded<string, "ToolId">;
export const processorId = (raw: string): ProcessorId => makeId("ProcessorId", raw);
export const toolId = (raw: string): ToolId => makeId("ToolId", raw);
