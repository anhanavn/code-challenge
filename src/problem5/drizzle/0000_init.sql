CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status_code" integer,
	"headers" text,
	"response_body" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"due_date" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_not_blank" CHECK (char_length(btrim("tasks"."title")) > 0),
	CONSTRAINT "tasks_description_length" CHECK (char_length("tasks"."description") <= 5000),
	CONSTRAINT "tasks_version_positive" CHECK ("tasks"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tasks_created_at_id_idx" ON "tasks" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_updated_at_id_idx" ON "tasks" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_title_id_idx" ON "tasks" USING btree ("title","id");--> statement-breakpoint
CREATE INDEX "tasks_priority_id_idx" ON "tasks" USING btree ("priority","id");--> statement-breakpoint
CREATE INDEX "tasks_status_created_at_idx" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date");