CREATE TABLE `cost_ledger` (
	`jobId` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`capability` text,
	`costUsd` real NOT NULL,
	`runtimeSeconds` real NOT NULL,
	`maxCostUsd` real,
	`maxRuntimeSeconds` real,
	`recordedAt` text NOT NULL
);
