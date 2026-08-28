CREATE TABLE "write_applications" (
	"idempotencyKey" text PRIMARY KEY NOT NULL,
	"targetSystem" text NOT NULL,
	"canonicalObjectKey" text NOT NULL,
	"payloadHash" text NOT NULL,
	"receipt" json NOT NULL,
	"appliedAt" text NOT NULL
);
