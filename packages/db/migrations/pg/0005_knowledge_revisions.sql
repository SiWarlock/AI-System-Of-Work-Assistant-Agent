CREATE TABLE "knowledge_revisions" (
	"idempotencyKey" text PRIMARY KEY NOT NULL,
	"revisionId" text NOT NULL,
	"baseRevisionId" text NOT NULL,
	"planId" text NOT NULL,
	"actor" text NOT NULL,
	"sourceEventRef" text NOT NULL,
	"workflowRunRef" json NOT NULL,
	"auditRecord" json NOT NULL,
	"committedAt" text NOT NULL
);
