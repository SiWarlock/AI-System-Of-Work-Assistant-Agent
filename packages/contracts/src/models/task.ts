// Task seam model (§13.15, §3/§6/§9). The typed Task entity — the sibling of the typed Project model
// (13.5) — carrying a `priority` that is OPTIONAL and NEVER inferred (absent ⇒ the unset/TBD state,
// REQ-F-017) plus an OPTIONAL `projectId` binding. A Task is a SEMANTIC (Markdown-canonical) entity: its
// canonical state lives in note frontmatter, KnowledgeWriter-owned (one-writer / Markdown-canonical
// invariant). The durable @sow/db `TaskRow` is only a derived operational rollup index — never a second
// writer of this entity (safety rule 1).
//
// Zod is the single source of truth: the TS type is the inferred shape (hand-declared as an interface only
// to dodge the TS4023 declaration-emit issue branded ids cause — see project.ts / approval.ts), the JSON
// Schema is generated. PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import { TaskIdSchema, WorkspaceIdSchema, ProjectIdSchema } from "../primitives/zod-brands";
import { taskLifecycleSchema, prioritySchema, provenanceOriginSchema } from "./shared-enums";
import type { TaskId, ProjectId } from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { TaskLifecycle, Priority, ProvenanceOrigin } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const TASK_SCHEMA_ID = "sow:task" as const;

/** Explicit output interface + annotation to dodge TS4023 (branded ids), same as project.ts / approval.ts. */
export interface Task {
  id: TaskId;
  /** WS-8 scope attribution (the served/authorized workspace this task belongs to). */
  workspaceId: WorkspaceId;
  /** OPTIONAL binding to the owning Project (a task without a project is valid — additive cross-entity ref). */
  projectId?: ProjectId;
  title: string;
  status: TaskLifecycle;
  /** OPTIONAL + NEVER inferred: absent IS the unset/TBD state (REQ-F-017) — only owner-set or extracted-with-evidence. */
  priority?: Priority;
  /** OPTIONAL due date (ISO-8601 datetime). */
  dueDate?: string;
  provenanceOrigin: ProvenanceOrigin;
}

interface TaskInput {
  id: string;
  workspaceId: string;
  projectId?: string;
  title: string;
  status: TaskLifecycle;
  priority?: Priority;
  dueDate?: string;
  provenanceOrigin: ProvenanceOrigin;
}

export const TaskSchema: z.ZodType<Task, z.ZodTypeDef, TaskInput> = z
  .object({
    id: TaskIdSchema,
    workspaceId: WorkspaceIdSchema,
    projectId: ProjectIdSchema.optional(),
    title: z.string().min(1),
    status: taskLifecycleSchema,
    priority: prioritySchema.optional(),
    dueDate: z.string().datetime().optional(),
    provenanceOrigin: provenanceOriginSchema,
  })
  .strict();
