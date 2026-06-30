// Branded/opaque ID types (1.1). Brands prevent cross-assignment at compile
// time; runtime constructors reject empty/whitespace. Pure — no app/adapter imports.

declare const __brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [__brand]: B };

export type WorkspaceId = Branded<string, "WorkspaceId">;
export type AgentJobId = Branded<string, "AgentJobId">;
export type ActionId = Branded<string, "ActionId">;
export type PlanId = Branded<string, "PlanId">;
export type SourceId = Branded<string, "SourceId">;
export type ApprovalId = Branded<string, "ApprovalId">;
export type WorkflowId = Branded<string, "WorkflowId">;
export type AuditId = Branded<string, "AuditId">;

/** Thrown when a branded-string constructor receives empty/whitespace input. */
export class InvalidIdError extends Error {
  constructor(
    readonly idType: string,
    readonly raw: unknown,
  ) {
    super(`Invalid ${idType}: expected a non-empty, non-whitespace string`);
    this.name = "InvalidIdError";
  }
}

/** Generic branded-string smart constructor. Rejects empty/whitespace. */
export function makeId<B extends string>(idType: B, raw: string): Branded<string, B> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new InvalidIdError(idType, raw);
  }
  return raw as Branded<string, B>;
}

export const workspaceId = (raw: string): WorkspaceId => makeId("WorkspaceId", raw);
export const agentJobId = (raw: string): AgentJobId => makeId("AgentJobId", raw);
export const actionId = (raw: string): ActionId => makeId("ActionId", raw);
export const planId = (raw: string): PlanId => makeId("PlanId", raw);
export const sourceId = (raw: string): SourceId => makeId("SourceId", raw);
export const approvalId = (raw: string): ApprovalId => makeId("ApprovalId", raw);
export const workflowId = (raw: string): WorkflowId => makeId("WorkflowId", raw);
export const auditId = (raw: string): AuditId => makeId("AuditId", raw);
