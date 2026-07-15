CREATE TABLE `cross_workspace_link` (
	`linkId` text PRIMARY KEY NOT NULL,
	`fromWorkspaceId` text NOT NULL,
	`toWorkspaceId` text NOT NULL,
	`scopeProjectionType` text NOT NULL,
	`scopeVisibilityLevel` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` text NOT NULL,
	`approvedAt` text,
	`revokedAt` text
);
