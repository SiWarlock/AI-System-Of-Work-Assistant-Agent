-- §13.10a approvals semantic subject: add the SUBJECT discriminator + the pending-KMP ref, and make
-- `actionRef` nullable (a semantic_mutation card carries `planRef`, not `actionRef`). Postgres alters
-- the column in place (SQLite's parallel 0003 must table-recreate). `subjectKind` NOT NULL backfills
-- legacy rows to 'external_action' (a SEMANTICALLY CORRECT backfill — every legacy approval predates
-- the Copilot bridge and IS an external write); `planRef` stays NULL for them. Additive + widening only.
ALTER TABLE "approvals" ALTER COLUMN "actionRef" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "planRef" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "subjectKind" text DEFAULT 'external_action' NOT NULL;