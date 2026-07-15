CREATE TABLE `seen_content_hash` (
	`workspaceId` text NOT NULL,
	`contentHash` text NOT NULL,
	`seenAt` text NOT NULL,
	PRIMARY KEY(`workspaceId`, `contentHash`)
);
