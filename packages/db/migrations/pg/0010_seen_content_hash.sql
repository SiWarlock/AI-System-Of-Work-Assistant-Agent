CREATE TABLE "seen_content_hash" (
	"workspaceId" text NOT NULL,
	"contentHash" text NOT NULL,
	"seenAt" text NOT NULL,
	CONSTRAINT "seen_content_hash_workspaceId_contentHash_pk" PRIMARY KEY("workspaceId","contentHash")
);
