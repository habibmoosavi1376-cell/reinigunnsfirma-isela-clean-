CREATE TYPE "public"."notification_purpose" AS ENUM('APPOINTMENT_REMINDER');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'DEAD', 'UNCERTAIN', 'NO_RECIPIENT', 'SUPPRESSED', 'OBSOLETE');--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"dedupe_key" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"booking_id" uuid,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_attempts_chk" CHECK ("notification_outbox"."attempts" >= 0 AND "notification_outbox"."attempts" <= 20),
	CONSTRAINT "notification_outbox_sent_chk" CHECK (("notification_outbox"."status" = 'SENT') = ("notification_outbox"."sent_at" IS NOT NULL)),
	CONSTRAINT "notification_outbox_sending_chk" CHECK ("notification_outbox"."status" <> 'SENDING' OR "notification_outbox"."claimed_at" IS NOT NULL),
	CONSTRAINT "notification_outbox_error_chk" CHECK ("notification_outbox"."last_error_code" IS NULL OR "notification_outbox"."last_error_code" ~ '^[A-Z_]{2,40}$')
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_uq" ON "notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");