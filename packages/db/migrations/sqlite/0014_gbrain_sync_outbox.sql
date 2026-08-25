CREATE TABLE `gbrain_sync_outbox` (
	`outboxId` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`revisionId` text NOT NULL,
	`planId` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`auditRef` text NOT NULL,
	`sourceEventRef` text,
	`enqueuedAt` text NOT NULL,
	`lastAttemptAt` text,
	`lastError` text
);
