CREATE TABLE "workspace_config" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"dataOwner" text NOT NULL,
	"markdownRepoPath" text NOT NULL,
	"gbrainBrainId" text NOT NULL,
	"defaultVisibility" text NOT NULL,
	"egressPolicy" json NOT NULL,
	"providerMatrix" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"eventId" text PRIMARY KEY NOT NULL,
	"eventName" text NOT NULL,
	"workspaceId" text,
	"correlationId" text,
	"workflowId" text,
	"payload" json,
	"occurredAt" text NOT NULL,
	"recordedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_refs" (
	"workflowId" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"state" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"auditRefs" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit" (
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"refs" json NOT NULL,
	"payloadHash" text NOT NULL,
	"beforeSummary" text NOT NULL,
	"afterSummary" text NOT NULL,
	"timestamps" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"actionRef" text NOT NULL,
	"status" text NOT NULL,
	"actor" text NOT NULL,
	"channel" text NOT NULL,
	"payloadHash" text NOT NULL,
	"snoozeUntil" text,
	"expiresAt" text
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"outboxId" text PRIMARY KEY NOT NULL,
	"actionRef" text NOT NULL,
	"workspaceId" text NOT NULL,
	"targetSystem" text NOT NULL,
	"canonicalObjectKey" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"payloadHash" text NOT NULL,
	"status" text NOT NULL,
	"payload" json,
	"writeReceipt" json,
	"attempts" integer NOT NULL,
	"enqueuedAt" text NOT NULL,
	"nextAttemptAt" text,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_cursors" (
	"connectorId" text NOT NULL,
	"workspaceId" text NOT NULL,
	"cursor" text,
	"status" text NOT NULL,
	"lastSyncAt" text,
	"nextSyncAt" text,
	"updatedAt" text NOT NULL,
	CONSTRAINT "connector_cursors_connectorId_workspaceId_pk" PRIMARY KEY("connectorId","workspaceId")
);
--> statement-breakpoint
CREATE TABLE "provider_state" (
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"model" text NOT NULL,
	"capabilities" json NOT NULL,
	"egressClass" text NOT NULL,
	"costCaps" json NOT NULL,
	"conformanceStatus" text NOT NULL,
	CONSTRAINT "provider_state_provider_endpoint_model_pk" PRIMARY KEY("provider","endpoint","model")
);
--> statement-breakpoint
CREATE TABLE "read_models" (
	"readModelKey" text NOT NULL,
	"workspaceId" text,
	"data" json NOT NULL,
	"rebuiltAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gcl_projections" (
	"workspaceId" text NOT NULL,
	"visibilityLevel" text NOT NULL,
	"projectionType" text NOT NULL,
	"sanitizedPayload" json NOT NULL,
	"sourceRefs" json NOT NULL,
	CONSTRAINT "gcl_projections_workspaceId_projectionType_visibilityLevel_pk" PRIMARY KEY("workspaceId","projectionType","visibilityLevel")
);
--> statement-breakpoint
CREATE TABLE "write_receipts" (
	"targetSystem" text NOT NULL,
	"canonicalObjectKey" text NOT NULL,
	"idempotencyKey" text,
	"payloadHash" text NOT NULL,
	"receipt" json,
	"recordedAt" text NOT NULL,
	CONSTRAINT "write_receipts_targetSystem_canonicalObjectKey_pk" PRIMARY KEY("targetSystem","canonicalObjectKey"),
	CONSTRAINT "write_receipts_idempotencyKey_unique" UNIQUE("idempotencyKey")
);
--> statement-breakpoint
ALTER TABLE "workflow_run_refs" ADD CONSTRAINT "workflow_run_refs_idempotencyKey_unique" UNIQUE("idempotencyKey");
--> statement-breakpoint
CREATE TABLE "health_items" (
	"dedupeKey" text PRIMARY KEY NOT NULL,
	"subjectRef" text NOT NULL,
	"id" text NOT NULL,
	"failureClass" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"auditRef" text NOT NULL,
	"openedAt" text NOT NULL,
	"state" text NOT NULL,
	"resolvedAt" text,
	"parityReportRef" text,
	"factIdentity" text,
	"lastSeen" text NOT NULL,
	"occurrenceCount" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_bookkeeping" (
	"scheduleId" text PRIMARY KEY NOT NULL,
	"lastRunWall" text NOT NULL,
	"lastRunMonotonicMs" integer,
	"lastRunMonotonicEpoch" text
);
--> statement-breakpoint
CREATE TABLE "instance_leases" (
	"taskQueue" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"acquiredAt" text NOT NULL,
	"expiresAt" text NOT NULL,
	"generation" integer NOT NULL
);
