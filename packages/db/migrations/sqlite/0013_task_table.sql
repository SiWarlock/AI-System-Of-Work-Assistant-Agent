CREATE TABLE `task` (
	`taskId` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`projectId` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`priority` text,
	`dueDate` text
);
