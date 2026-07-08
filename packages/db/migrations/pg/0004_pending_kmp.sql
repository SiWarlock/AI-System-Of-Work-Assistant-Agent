-- §13.10a — the pending-KMP operational store (the semantic-write sibling of `outbox`).
-- Additive: a brand-new table holding a derived §6 KnowledgeMutationPlan (one `plan` json
-- column) keyed by planId, pending owner approval. No change to any existing table.
CREATE TABLE "pending_knowledge_mutations" (
	"planId" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"plan" json NOT NULL,
	"payloadHash" text NOT NULL,
	"status" text NOT NULL,
	"recordedAt" text NOT NULL,
	"settledAt" text
);
