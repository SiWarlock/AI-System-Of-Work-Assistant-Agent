CREATE TABLE `source_disposition` (
	`sourceId` text PRIMARY KEY NOT NULL,
	`sourceEnvelope` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`state` text NOT NULL,
	`dispositionKey` text,
	`auditRef` text,
	`parkedAt` text NOT NULL,
	`dispositionedAt` text
);
