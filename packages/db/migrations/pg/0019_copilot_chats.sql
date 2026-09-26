CREATE TABLE "copilot_chat_turns" (
	"turnId" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"workspaceId" text NOT NULL,
	"seq" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_chats" (
	"chatId" text PRIMARY KEY NOT NULL,
	"workspaceId" text NOT NULL,
	"title" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
