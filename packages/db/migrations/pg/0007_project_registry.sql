CREATE TABLE "project_registry" (
	"projectId" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"planPath" text,
	"progressProviders" json NOT NULL,
	"aliases" json,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"lifecycleState" text NOT NULL
);
