CREATE TYPE "public"."callback_time_window" AS ENUM('ANY', 'MORNING', 'MIDDAY', 'AFTERNOON');--> statement-breakpoint
CREATE TABLE "callback_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"submitted_by_user_id" text,
	"customer_type" "request_customer_type" NOT NULL,
	"service_category_id" uuid,
	"postal_code" text,
	"preferred_window" "callback_time_window" DEFAULT 'ANY' NOT NULL,
	"message" text,
	"privacy_notice_version" text NOT NULL,
	"privacy_notice_acknowledged_at" timestamp with time zone NOT NULL,
	"submission_key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callback_request_message_chk" CHECK ("callback_request"."message" IS NULL OR length("callback_request"."message") <= 500),
	CONSTRAINT "callback_request_postal_code_chk" CHECK ("callback_request"."postal_code" IS NULL OR length("callback_request"."postal_code") <= 10)
);
--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "submission_key_hash" text;--> statement-breakpoint
ALTER TABLE "callback_request" ADD CONSTRAINT "callback_request_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_request" ADD CONSTRAINT "callback_request_service_category_id_service_category_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "callback_request_lead_uq" ON "callback_request" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "callback_request_submission_key_uq" ON "callback_request" USING btree ("submission_key_hash");--> statement-breakpoint
CREATE INDEX "callback_request_created_idx" ON "callback_request" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_request_submission_key_uq" ON "service_request" USING btree ("submission_key_hash");