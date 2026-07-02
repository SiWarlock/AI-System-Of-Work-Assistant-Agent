CREATE TABLE `workspace_config` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`dataOwner` text NOT NULL,
	`markdownRepoPath` text NOT NULL,
	`gbrainBrainId` text NOT NULL,
	`defaultVisibility` text NOT NULL,
	`egressPolicy` text NOT NULL,
	`providerMatrix` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_log` (
	`eventId` text PRIMARY KEY NOT NULL,
	`eventName` text NOT NULL,
	`workspaceId` text,
	`correlationId` text,
	`workflowId` text,
	`payload` text,
	`occurredAt` text NOT NULL,
	`recordedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_run_refs` (
	`workflowId` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`state` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`auditRefs` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`actor` text NOT NULL,
	`event` text NOT NULL,
	`refs` text NOT NULL,
	`payloadHash` text NOT NULL,
	`beforeSummary` text NOT NULL,
	`afterSummary` text NOT NULL,
	`timestamps` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`actionRef` text NOT NULL,
	`status` text NOT NULL,
	`actor` text NOT NULL,
	`channel` text NOT NULL,
	`payloadHash` text NOT NULL,
	`snoozeUntil` text,
	`expiresAt` text
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`outboxId` text PRIMARY KEY NOT NULL,
	`actionRef` text NOT NULL,
	`workspaceId` text NOT NULL,
	`targetSystem` text NOT NULL,
	`canonicalObjectKey` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`payloadHash` text NOT NULL,
	`status` text NOT NULL,
	`payload` text,
	`writeReceipt` text,
	`attempts` integer NOT NULL,
	`enqueuedAt` text NOT NULL,
	`nextAttemptAt` text,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connector_cursors` (
	`connectorId` text NOT NULL,
	`workspaceId` text NOT NULL,
	`cursor` text,
	`status` text NOT NULL,
	`lastSyncAt` text,
	`nextSyncAt` text,
	`updatedAt` text NOT NULL,
	PRIMARY KEY(`connectorId`, `workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `provider_state` (
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`capabilities` text NOT NULL,
	`egressClass` text NOT NULL,
	`costCaps` text NOT NULL,
	`conformanceStatus` text NOT NULL,
	PRIMARY KEY(`provider`, `endpoint`, `model`)
);
--> statement-breakpoint
CREATE TABLE `read_models` (
	`readModelKey` text NOT NULL,
	`workspaceId` text,
	`data` text NOT NULL,
	`rebuiltAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gcl_projections` (
	`workspaceId` text NOT NULL,
	`visibilityLevel` text NOT NULL,
	`projectionType` text NOT NULL,
	`sanitizedPayload` text NOT NULL,
	`sourceRefs` text NOT NULL,
	PRIMARY KEY(`workspaceId`, `projectionType`, `visibilityLevel`)
);
--> statement-breakpoint
CREATE TABLE `write_receipts` (
	`targetSystem` text NOT NULL,
	`canonicalObjectKey` text NOT NULL,
	`idempotencyKey` text,
	`payloadHash` text NOT NULL,
	`receipt` text,
	`recordedAt` text NOT NULL,
	PRIMARY KEY(`targetSystem`, `canonicalObjectKey`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `write_receipts_idempotencyKey_unique` ON `write_receipts` (`idempotencyKey`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_refs_idempotencyKey_unique` ON `workflow_run_refs` (`idempotencyKey`);
