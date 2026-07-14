CREATE TABLE "parity_reports" (
	"reportId" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"reconciledAtRevision" text NOT NULL,
	"recordedAt" text NOT NULL,
	"payload" json NOT NULL
);
