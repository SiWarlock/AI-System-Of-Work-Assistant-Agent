CREATE TABLE "connector_instance" (
	"instanceId" text PRIMARY KEY NOT NULL,
	"connectorId" text NOT NULL,
	"workspaceId" text NOT NULL,
	"tokenRef" text NOT NULL,
	"state" text NOT NULL,
	"cadence" text NOT NULL
);
