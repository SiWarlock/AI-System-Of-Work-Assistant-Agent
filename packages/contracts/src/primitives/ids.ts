// Branded/opaque ID types (1.1). Brands prevent cross-assignment at compile
// time; runtime constructors reject empty/whitespace. Pure — no app/adapter imports.
//
// ### 24.100 — every named constructor below RUNS its brand's own governing
// Zod schema (imported from `./zod-brands`) via `makeId`'s required `schema`
// parameter, rather than a bare non-empty check + cast. `zod-brands.ts`
// type-imports ONLY types from this file (`import type`, fully erased), so
// this file importing VALUES from `zod-brands.ts` creates no runtime cycle —
// verified by `pnpm --filter @sow/contracts typecheck` staying green.
import {
  WorkspaceIdSchema,
  AgentJobIdSchema,
  ActionIdSchema,
  PlanIdSchema,
  SourceIdSchema,
  ApprovalIdSchema,
  WorkflowIdSchema,
  AuditIdSchema,
} from "./zod-brands";

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

/**
 * The minimal shape a brand's governing Zod schema must expose for `makeId`
 * to RUN it (### 24.100). Deliberately not `zod`'s own `ZodType` — this
 * keeps `ids.ts` decoupled from Zod's full type surface, needing only the
 * one method `makeId` calls. A `z.ZodType<Branded<string,B>, ..., string>`
 * satisfies this structurally (its `safeParse` returns a superset union).
 */
export interface BrandParser<B> {
  safeParse: (raw: unknown) => { success: true; data: B } | { success: false };
}

/**
 * Generic branded-string smart constructor (### 24.100). RUNS the brand's
 * own governing schema — never a bare non-empty check + cast — so a value
 * that fails ITS schema's shape (not merely "is it blank") throws the same
 * `InvalidIdError` every existing caller already expects. `WorkspaceIdSchema`
 * narrows beyond blank-rejection (### 24.84); every other brand below is the
 * blank-rejecting factory (`brandedIdSchema` in `zod-brands.ts`) — routing
 * ALL of them through their own schema, rather than special-casing
 * WorkspaceId, means a FUTURE narrowing of any brand's schema is inherited
 * by its constructor for free, with no second bypass site to remember to
 * close.
 */
export function makeId<B extends string>(
  idType: B,
  raw: string,
  schema: BrandParser<Branded<string, B>>,
): Branded<string, B> {
  if (typeof raw !== "string") {
    throw new InvalidIdError(idType, raw);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InvalidIdError(idType, raw);
  }
  return result.data;
}

export const workspaceId = (raw: string): WorkspaceId => makeId("WorkspaceId", raw, WorkspaceIdSchema);
export const agentJobId = (raw: string): AgentJobId => makeId("AgentJobId", raw, AgentJobIdSchema);
export const actionId = (raw: string): ActionId => makeId("ActionId", raw, ActionIdSchema);
export const planId = (raw: string): PlanId => makeId("PlanId", raw, PlanIdSchema);
export const sourceId = (raw: string): SourceId => makeId("SourceId", raw, SourceIdSchema);
export const approvalId = (raw: string): ApprovalId => makeId("ApprovalId", raw, ApprovalIdSchema);
export const workflowId = (raw: string): WorkflowId => makeId("WorkflowId", raw, WorkflowIdSchema);
export const auditId = (raw: string): AuditId => makeId("AuditId", raw, AuditIdSchema);
