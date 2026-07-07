// Project seam model (§13.5, §3/§6/§9). The typed Project entity behind the §9.5 Projects dashboard — the
// canonical frontmatter shape KnowledgeWriter reads/writes for a project note, PLUS a bi-temporal status
// timeline (event-time vs transaction-time; status APPENDED, never overwritten — an append-only lifecycle
// history the KnowledgeWriter maintains). A Project is a SEMANTIC (Markdown-canonical) entity: its state lives
// in note frontmatter, not an operational table (one-writer / Markdown-canonical invariant). Numeric progress
// is NOT stored here — it is a deterministic parse of the note's checkboxes (REQ-F-011), computed by the
// dashboard projector, never a model-supplied %.
//
// Zod is the single source of truth: the TS type is the inferred shape (hand-declared as an interface only to
// dodge the TS4023 declaration-emit issue branded ids cause — see approval.ts), the JSON Schema is generated.
// PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import { ProjectIdSchema, WorkspaceIdSchema } from "../primitives/zod-brands";
import { projectLifecycleStateSchema, provenanceOriginSchema } from "./shared-enums";
import type { ProjectId } from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { ProjectLifecycleState, ProvenanceOrigin } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PROJECT_SCHEMA_ID = "sow:project" as const;

/**
 * One bi-temporal status-timeline entry: the project entered `state` at `eventTime` (when it happened in the
 * world) and that fact was recorded at `transactionTime` (when the system wrote it). The timeline is
 * APPEND-ONLY (a status change appends an entry; entries are never mutated), which is how the "status appended,
 * never overwritten" invariant (§13.5) is realized — the full lifecycle history is preserved.
 */
export interface ProjectStatusEntry {
  state: ProjectLifecycleState;
  eventTime: string;
  transactionTime: string;
}

/** Explicit output interface + annotation to dodge TS4023 (branded ids), same as approval.ts / egress-policy.ts. */
export interface Project {
  id: ProjectId;
  /** WS-8 scope attribution (the served/authorized workspace this project belongs to). */
  workspaceId: WorkspaceId;
  /** The canonical note slug the project's frontmatter lives in (links the entity to its Markdown). */
  slug: string;
  title: string;
  /** The CURRENT lifecycle state — an invariant MUST equal the latest timeline entry's `state` (see refine). */
  lifecycleState: ProjectLifecycleState;
  /** The append-only bi-temporal status history (non-empty; the first entry is the project's inception). */
  timeline: ProjectStatusEntry[];
  provenanceOrigin: ProvenanceOrigin;
}

interface ProjectStatusEntryInput {
  state: ProjectLifecycleState;
  eventTime: string;
  transactionTime: string;
}
interface ProjectInput {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  lifecycleState: ProjectLifecycleState;
  timeline: ProjectStatusEntryInput[];
  provenanceOrigin: ProvenanceOrigin;
}

const ProjectStatusEntrySchema = z
  .object({
    state: projectLifecycleStateSchema,
    eventTime: z.string().datetime(),
    transactionTime: z.string().datetime(),
  })
  .strict();

export const ProjectSchema: z.ZodType<Project, z.ZodTypeDef, ProjectInput> = z
  .object({
    id: ProjectIdSchema,
    workspaceId: WorkspaceIdSchema,
    slug: z.string().min(1),
    title: z.string().min(1),
    lifecycleState: projectLifecycleStateSchema,
    // Non-empty: a project always has at least its inception entry — the timeline IS the lifecycle history.
    timeline: z.array(ProjectStatusEntrySchema).min(1),
    provenanceOrigin: provenanceOriginSchema,
  })
  .strict()
  // The current `lifecycleState` MUST be the latest timeline entry's state — the two cannot disagree (the
  // scalar is a denormalized convenience over the append-only history's head). A record whose head state
  // differs from `lifecycleState` is contradictory and rejected.
  .refine((p) => p.timeline[p.timeline.length - 1]?.state === p.lifecycleState, {
    message: "lifecycleState must equal the latest timeline entry's state",
    path: ["lifecycleState"],
  });
