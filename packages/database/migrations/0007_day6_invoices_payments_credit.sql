CREATE TYPE "public"."credit_terms_status" AS ENUM('REQUESTED', 'APPROVED', 'DENIED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('PREPAYMENT', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."invoice_payment_terms" AS ENUM('VORKASSE', 'CREDIT_TERMS');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('BANK_TRANSFER', 'SEPA_DIRECT_DEBIT', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_record_status" AS ENUM('PENDING', 'AUTHORIZED', 'CONFIRMED', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CHARGED_BACK');--> statement-breakpoint
CREATE TYPE "public"."payment_terms_outcome" AS ENUM('VORKASSE_REQUIRED', 'CREDIT_TERMS_ALLOWED', 'BLOCKED', 'REVIEW_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."provider_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."risk_evaluation_trigger" AS ENUM('BOOKING', 'PAYMENT', 'OVERDUE', 'CREDIT_DECISION', 'MANUAL');--> statement-breakpoint
CREATE TABLE "credit_terms_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "credit_terms_status" DEFAULT 'REQUESTED' NOT NULL,
	"request_reason" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"credit_limit_cents" bigint,
	"trust_score" integer,
	"valid_until" date,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_terms_decision_chk" CHECK (("credit_terms_approval"."status" = 'REQUESTED') = ("credit_terms_approval"."decided_at" IS NULL) AND
        ("credit_terms_approval"."decided_at" IS NULL OR ("credit_terms_approval"."decided_by_user_id" IS NOT NULL AND "credit_terms_approval"."decision_reason" IS NOT NULL))),
	CONSTRAINT "credit_terms_approved_chk" CHECK ("credit_terms_approval"."status" NOT IN ('APPROVED', 'REVOKED') OR "credit_terms_approval"."decided_by_user_id" IS NULL OR
        ("credit_terms_approval"."credit_limit_cents" > 0 AND "credit_terms_approval"."trust_score" BETWEEN 0 AND 100)),
	CONSTRAINT "credit_terms_four_eyes_chk" CHECK ("credit_terms_approval"."status" NOT IN ('APPROVED', 'REVOKED') OR "credit_terms_approval"."decided_by_user_id" IS NULL OR "credit_terms_approval"."decided_by_user_id" <> "credit_terms_approval"."requested_by_user_id"),
	CONSTRAINT "credit_terms_revoke_chk" CHECK (("credit_terms_approval"."status" = 'REVOKED') = ("credit_terms_approval"."revoked_at" IS NOT NULL AND "credit_terms_approval"."revoked_by_user_id" IS NOT NULL AND "credit_terms_approval"."revoke_reason" IS NOT NULL)),
	CONSTRAINT "credit_terms_text_chk" CHECK (length("credit_terms_approval"."request_reason") BETWEEN 3 AND 1000 AND
        ("credit_terms_approval"."decision_reason" IS NULL OR length("credit_terms_approval"."decision_reason") <= 1000) AND
        ("credit_terms_approval"."revoke_reason" IS NULL OR length("credit_terms_approval"."revoke_reason") <= 1000)),
	CONSTRAINT "credit_terms_version_chk" CHECK ("credit_terms_approval"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text,
	"kind" "invoice_kind" NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"quote_id" uuid,
	"job_id" uuid,
	"payment_terms" "invoice_payment_terms" NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"net_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"issue_date" date,
	"due_date" date,
	"created_by_user_id" text NOT NULL,
	"issued_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "invoice_amounts_chk" CHECK ("invoice"."net_cents" > 0 AND "invoice"."tax_cents" >= 0 AND "invoice"."gross_cents" = "invoice"."net_cents" + "invoice"."tax_cents"),
	CONSTRAINT "invoice_paid_range_chk" CHECK ("invoice"."paid_cents" >= 0 AND "invoice"."paid_cents" <= "invoice"."gross_cents"),
	CONSTRAINT "invoice_paid_status_chk" CHECK (("invoice"."status" <> 'PAID' OR ("invoice"."paid_cents" = "invoice"."gross_cents" AND "invoice"."paid_at" IS NOT NULL)) AND
        ("invoice"."status" NOT IN ('ISSUED', 'OPEN') OR "invoice"."paid_cents" = 0) AND
        ("invoice"."status" <> 'OVERDUE' OR "invoice"."paid_cents" < "invoice"."gross_cents") AND
        ("invoice"."status" <> 'PARTIALLY_PAID' OR ("invoice"."paid_cents" > 0 AND "invoice"."paid_cents" < "invoice"."gross_cents")) AND
        ("invoice"."status" NOT IN ('DRAFT', 'CANCELLED') OR "invoice"."paid_cents" = 0)),
	CONSTRAINT "invoice_number_chk" CHECK (("invoice"."status" IN ('DRAFT', 'CANCELLED')) = ("invoice"."invoice_number" IS NULL) AND
        ("invoice"."invoice_number" IS NULL OR length("invoice"."invoice_number") BETWEEN 3 AND 40)),
	CONSTRAINT "invoice_issued_chk" CHECK ("invoice"."status" IN ('DRAFT', 'CANCELLED') OR ("invoice"."issue_date" IS NOT NULL AND "invoice"."due_date" IS NOT NULL AND
        "invoice"."due_date" >= "invoice"."issue_date" AND "invoice"."issued_at" IS NOT NULL AND "invoice"."issued_by_user_id" IS NOT NULL)),
	CONSTRAINT "invoice_void_chk" CHECK (("invoice"."status" = 'VOID') = ("invoice"."voided_at" IS NOT NULL AND "invoice"."void_reason" IS NOT NULL) AND
        ("invoice"."void_reason" IS NULL OR length("invoice"."void_reason") <= 1000)),
	CONSTRAINT "invoice_terms_chk" CHECK (("invoice"."kind" = 'PREPAYMENT') = ("invoice"."payment_terms" = 'VORKASSE') AND
        ("invoice"."kind" <> 'FINAL' OR "invoice"."job_id" IS NOT NULL)),
	CONSTRAINT "invoice_version_chk" CHECK ("invoice"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoice_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"booking_item_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit" "service_unit" NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"net_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_item_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_item_quantity_chk" CHECK ("invoice_item"."quantity" > 0),
	CONSTRAINT "invoice_item_amounts_chk" CHECK ("invoice_item"."unit_price_cents" >= 0 AND "invoice_item"."net_cents" >= 0 AND "invoice_item"."tax_cents" >= 0 AND "invoice_item"."gross_cents" = "invoice_item"."net_cents" + "invoice_item"."tax_cents"),
	CONSTRAINT "invoice_item_tax_rate_chk" CHECK ("invoice_item"."tax_rate_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "invoice_number_counter" (
	"series_key" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_number_counter_pk" PRIMARY KEY("series_key","year"),
	CONSTRAINT "invoice_number_counter_value_chk" CHECK ("invoice_number_counter"."last_value" >= 1),
	CONSTRAINT "invoice_number_counter_year_chk" CHECK ("invoice_number_counter"."year" BETWEEN 2000 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "invoice_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"from_status" "invoice_status",
	"to_status" "invoice_status" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_status_transition_change_chk" CHECK ("invoice_status_transition"."from_status" IS NULL OR "invoice_status_transition"."from_status" <> "invoice_status_transition"."to_status"),
	CONSTRAINT "invoice_status_transition_reason_chk" CHECK ("invoice_status_transition"."reason" IS NULL OR length("invoice_status_transition"."reason") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "payment_record_status" DEFAULT 'PENDING' NOT NULL,
	"method" "payment_method" NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"applied_cents" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"charged_back_at" timestamp with time zone,
	"status_reason" text,
	"recorded_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_chk" CHECK ("payment"."amount_cents" > 0),
	CONSTRAINT "payment_applied_chk" CHECK ("payment"."applied_cents" >= 0 AND "payment"."applied_cents" <= "payment"."amount_cents" AND
        ("payment"."status" IN ('CONFIRMED', 'REFUND_PENDING') OR "payment"."applied_cents" = 0)),
	CONSTRAINT "payment_confirmed_chk" CHECK ("payment"."status" NOT IN ('CONFIRMED', 'REFUND_PENDING', 'REFUNDED', 'CHARGED_BACK') OR "payment"."confirmed_at" IS NOT NULL),
	CONSTRAINT "payment_text_chk" CHECK (length("payment"."idempotency_key") BETWEEN 8 AND 200 AND length("payment"."provider") BETWEEN 1 AND 40 AND
        ("payment"."provider_payment_id" IS NULL OR length("payment"."provider_payment_id") <= 200) AND
        ("payment"."status_reason" IS NULL OR length("payment"."status_reason") <= 500)),
	CONSTRAINT "payment_version_chk" CHECK ("payment"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_provider_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"status" "provider_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payment_id" uuid,
	"outcome" text,
	CONSTRAINT "payment_provider_event_text_chk" CHECK (length("payment_provider_event"."provider_event_id") BETWEEN 1 AND 200 AND length("payment_provider_event"."event_type") BETWEEN 1 AND 100 AND
        ("payment_provider_event"."outcome" IS NULL OR length("payment_provider_event"."outcome") <= 200)),
	CONSTRAINT "payment_provider_event_processed_chk" CHECK (("payment_provider_event"."status" = 'RECEIVED') = ("payment_provider_event"."processed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reference_amount_chk" CHECK ("payment_reference"."amount_cents" > 0),
	CONSTRAINT "payment_reference_text_chk" CHECK (length("payment_reference"."reference") BETWEEN 3 AND 200)
);
--> statement-breakpoint
CREATE TABLE "payment_risk_evaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"outcome" "payment_terms_outcome" NOT NULL,
	"reasons" text[] NOT NULL,
	"facts" jsonb NOT NULL,
	"policy_version" integer,
	"trigger" "risk_evaluation_trigger" NOT NULL,
	"actor_user_id" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"from_status" "payment_record_status",
	"to_status" "payment_record_status" NOT NULL,
	"actor_user_id" text,
	"provider_event_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transition_change_chk" CHECK ("payment_transition"."from_status" IS NULL OR "payment_transition"."from_status" <> "payment_transition"."to_status"),
	CONSTRAINT "payment_transition_reason_chk" CHECK ("payment_transition"."reason" IS NULL OR length("payment_transition"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "payment_review_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_terms_approval" ADD CONSTRAINT "credit_terms_approval_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_terms_approval" ADD CONSTRAINT "credit_terms_approval_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_terms_approval" ADD CONSTRAINT "credit_terms_approval_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_terms_approval" ADD CONSTRAINT "credit_terms_approval_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_by_user_id_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_booking_item_id_booking_item_id_fk" FOREIGN KEY ("booking_item_id") REFERENCES "public"."booking_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_transition" ADD CONSTRAINT "invoice_status_transition_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_event" ADD CONSTRAINT "payment_provider_event_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_risk_evaluation" ADD CONSTRAINT "payment_risk_evaluation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transition" ADD CONSTRAINT "payment_transition_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_terms_active_uq" ON "credit_terms_approval" USING btree ("customer_id") WHERE "credit_terms_approval"."status" IN ('REQUESTED', 'APPROVED');--> statement-breakpoint
CREATE INDEX "credit_terms_customer_idx" ON "credit_terms_approval" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_number_uq" ON "invoice" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_booking_active_uq" ON "invoice" USING btree ("booking_id") WHERE "invoice"."status" NOT IN ('CANCELLED', 'VOID');--> statement-breakpoint
CREATE INDEX "invoice_customer_created_idx" ON "invoice" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_status_due_idx" ON "invoice" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "invoice_created_idx" ON "invoice" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoice_status_transition_invoice_idx" ON "invoice_status_transition" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_idempotency_key_uq" ON "payment" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_payment_uq" ON "payment" USING btree ("provider","provider_payment_id") WHERE "payment"."provider_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_invoice_idx" ON "payment" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_customer_status_idx" ON "payment" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "payment_status_created_idx" ON "payment" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_event_uq" ON "payment_provider_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_provider_event_payment_idx" ON "payment_provider_event" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reference_provider_uq" ON "payment_reference" USING btree ("provider","reference");--> statement-breakpoint
CREATE INDEX "payment_reference_payment_idx" ON "payment_reference" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_risk_evaluation_customer_idx" ON "payment_risk_evaluation" USING btree ("customer_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "payment_transition_payment_idx" ON "payment_transition" USING btree ("payment_id");-- ---------------------------------------------------------------------------------------------
-- Hand-written integrity guards (day 6). Defence in depth to the billing domain services.
-- Purely additive: new triggers/functions; the day-5 job payment guard function is replaced by
-- a stricter version (same trigger, all previous conditions kept).
-- ---------------------------------------------------------------------------------------------
-- Financial evidence is append-only.
CREATE TRIGGER invoice_item_append_only
  BEFORE UPDATE OR DELETE ON "invoice_item"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER invoice_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "invoice_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_transition_append_only
  BEFORE UPDATE OR DELETE ON "payment_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_reference_append_only
  BEFORE UPDATE OR DELETE ON "payment_reference"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_risk_evaluation_append_only
  BEFORE UPDATE OR DELETE ON "payment_risk_evaluation"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
-- Invoices, payments, provider events and credit decisions are never deleted (history).
CREATE TRIGGER invoice_no_delete
  BEFORE DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_no_delete
  BEFORE DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_provider_event_no_delete
  BEFORE DELETE ON "payment_provider_event"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER credit_terms_approval_no_delete
  BEFORE DELETE ON "credit_terms_approval"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER invoice_number_counter_no_delete
  BEFORE DELETE ON "invoice_number_counter"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER invoice_no_truncate
  BEFORE TRUNCATE ON "invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_no_truncate
  BEFORE TRUNCATE ON "payment"
  FOR EACH STATEMENT EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
-- Invoice numbers only ever move forward.
CREATE OR REPLACE FUNCTION isela_invoice_counter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."series_key" <> OLD."series_key" OR NEW."year" <> OLD."year" OR NEW."last_value" <= OLD."last_value" THEN
    RAISE EXCEPTION 'invoice number counters only move forward'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_number_counter_forward_only
  BEFORE UPDATE ON "invoice_number_counter"
  FOR EACH ROW EXECUTE FUNCTION isela_invoice_counter_guard();
--> statement-breakpoint
-- Invoice creation: customer, property and job must belong to the booking (no forged links).
CREATE OR REPLACE FUNCTION isela_invoice_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' OR NEW."paid_cents" <> 0 THEN
    RAISE EXCEPTION 'invoices are created as unpaid drafts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = NEW."booking_id"
      AND b."customer_id" = NEW."customer_id"
      AND b."property_id" = NEW."property_id"
      AND b."currency" = NEW."currency"
      AND b."quote_id" IS NOT DISTINCT FROM NEW."quote_id"
  ) THEN
    RAISE EXCEPTION 'invoice does not match its booking'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."job_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "job" j WHERE j."id" = NEW."job_id" AND j."booking_id" = NEW."booking_id"
  ) THEN
    RAISE EXCEPTION 'invoice job does not belong to the booking'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_insert_guard
  BEFORE INSERT ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION isela_invoice_insert_guard();
--> statement-breakpoint
-- Invoice immutability and status machine: the snapshot never changes; the number is set
-- exactly once (at issuance); only allowed status transitions; totals are re-checked at issuance.
CREATE OR REPLACE FUNCTION isela_invoice_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  items_net bigint;
  items_count integer;
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
    OR NEW."property_id" IS DISTINCT FROM OLD."property_id"
    OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."job_id" IS DISTINCT FROM OLD."job_id"
    OR NEW."payment_terms" IS DISTINCT FROM OLD."payment_terms"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."net_cents" IS DISTINCT FROM OLD."net_cents"
    OR NEW."tax_cents" IS DISTINCT FROM OLD."tax_cents"
    OR NEW."gross_cents" IS DISTINCT FROM OLD."gross_cents"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'invoice % snapshot is immutable', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."invoice_number" IS DISTINCT FROM OLD."invoice_number"
    OR NEW."issue_date" IS DISTINCT FROM OLD."issue_date"
    OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
    OR NEW."issued_by_user_id" IS DISTINCT FROM OLD."issued_by_user_id") THEN
    RAISE EXCEPTION 'invoice % is issued and immutable', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'VOID') AND (
    NEW."status" IS DISTINCT FROM OLD."status" OR NEW."due_date" IS DISTINCT FROM OLD."due_date") THEN
    RAISE EXCEPTION 'invoice % is closed', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'CANCELLED')) OR
    (OLD."status" = 'ISSUED' AND NEW."status" IN ('OPEN', 'VOID')) OR
    (OLD."status" = 'OPEN' AND NEW."status" IN ('PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID')) OR
    (OLD."status" = 'PARTIALLY_PAID' AND NEW."status" IN ('OPEN', 'PAID', 'OVERDUE', 'VOID')) OR
    (OLD."status" = 'OVERDUE' AND NEW."status" IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID')) OR
    (OLD."status" = 'PAID' AND NEW."status" IN ('OPEN', 'PARTIALLY_PAID', 'OVERDUE', 'VOID'))
  ) THEN
    RAISE EXCEPTION 'invoice status transition % -> % not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' THEN
    SELECT COALESCE(SUM(i."net_cents"), 0), COUNT(*) INTO items_net, items_count
      FROM "invoice_item" i WHERE i."invoice_id" = NEW."id";
    IF items_count = 0 OR items_net <> NEW."net_cents" THEN
      RAISE EXCEPTION 'invoice % items do not match its totals', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_update_guard
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION isela_invoice_update_guard();
--> statement-breakpoint
-- Items can only be added while the invoice is a draft.
CREATE OR REPLACE FUNCTION isela_invoice_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "invoice" i WHERE i."id" = NEW."invoice_id" AND i."status" = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'items can only be added to draft invoices'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_item_draft_only
  BEFORE INSERT ON "invoice_item"
  FOR EACH ROW EXECUTE FUNCTION isela_invoice_item_guard();
--> statement-breakpoint
-- Payments: belong to the invoice's customer and currency, only on payable invoices, recorded
-- facts are immutable, and only allowed status transitions.
CREATE OR REPLACE FUNCTION isela_payment_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'AUTHORIZED') OR NEW."applied_cents" <> 0 THEN
    RAISE EXCEPTION 'payments are recorded as pending'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "invoice" i
    WHERE i."id" = NEW."invoice_id"
      AND i."customer_id" = NEW."customer_id"
      AND i."currency" = NEW."currency"
      AND i."status" IN ('OPEN', 'PARTIALLY_PAID', 'OVERDUE')
  ) THEN
    RAISE EXCEPTION 'payment does not match a payable invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_insert_guard
  BEFORE INSERT ON "payment"
  FOR EACH ROW EXECUTE FUNCTION isela_payment_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION isela_payment_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."invoice_id" IS DISTINCT FROM OLD."invoice_id"
    OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
    OR NEW."recorded_by_user_id" IS DISTINCT FROM OLD."recorded_by_user_id"
    OR (OLD."provider_payment_id" IS NOT NULL AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id") THEN
    RAISE EXCEPTION 'payment % facts are immutable', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('AUTHORIZED', 'CONFIRMED', 'FAILED')) OR
    (OLD."status" = 'AUTHORIZED' AND NEW."status" IN ('CONFIRMED', 'FAILED')) OR
    (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('REFUND_PENDING', 'CHARGED_BACK')) OR
    (OLD."status" = 'REFUND_PENDING' AND NEW."status" IN ('REFUNDED', 'CONFIRMED'))
  ) THEN
    RAISE EXCEPTION 'payment status transition % -> % not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_update_guard
  BEFORE UPDATE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION isela_payment_update_guard();
--> statement-breakpoint
-- Provider events: only the processing result may be set, once.
CREATE OR REPLACE FUNCTION isela_provider_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'RECEIVED'
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."provider_event_id" IS DISTINCT FROM OLD."provider_event_id"
    OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
    OR NEW."payload_sha256" IS DISTINCT FROM OLD."payload_sha256"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
    OR NEW."received_at" IS DISTINCT FROM OLD."received_at" THEN
    RAISE EXCEPTION 'provider event % is immutable', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_provider_event_guard
  BEFORE UPDATE ON "payment_provider_event"
  FOR EACH ROW EXECUTE FUNCTION isela_provider_event_guard();
--> statement-breakpoint
-- Credit-terms decisions: requested facts immutable, decisions final, only allowed steps.
CREATE OR REPLACE FUNCTION isela_credit_terms_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
    OR NEW."request_reason" IS DISTINCT FROM OLD."request_reason"
    OR NEW."requested_by_user_id" IS DISTINCT FROM OLD."requested_by_user_id"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
    OR (OLD."status" <> 'REQUESTED' AND (
      NEW."credit_limit_cents" IS DISTINCT FROM OLD."credit_limit_cents"
      OR NEW."trust_score" IS DISTINCT FROM OLD."trust_score"
      OR NEW."valid_until" IS DISTINCT FROM OLD."valid_until"
      OR NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
      OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
      OR NEW."decision_reason" IS DISTINCT FROM OLD."decision_reason")) THEN
    RAISE EXCEPTION 'credit terms decision % is immutable', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'DENIED')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'credit terms transition % -> % not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_terms_approval_guard
  BEFORE UPDATE ON "credit_terms_approval"
  FOR EACH ROW EXECUTE FUNCTION isela_credit_terms_guard();
--> statement-breakpoint
-- Credit terms on a booking require an active approval and no overdue invoice of the customer.
CREATE OR REPLACE FUNCTION isela_customer_credit_ok(target_customer uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM "credit_terms_approval" c
      WHERE c."customer_id" = target_customer
        AND c."status" = 'APPROVED'
        AND (c."valid_until" IS NULL OR c."valid_until" >= CURRENT_DATE)
    )
    AND NOT EXISTS (
      SELECT 1 FROM "invoice" i
      WHERE i."customer_id" = target_customer AND i."status" = 'OVERDUE'
    );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION isela_booking_credit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payment_requirement" = 'CREDIT_TERMS_APPROVED'
    AND (TG_OP = 'INSERT' OR OLD."payment_requirement" IS DISTINCT FROM 'CREDIT_TERMS_APPROVED')
    AND NOT isela_customer_credit_ok(NEW."customer_id") THEN
    RAISE EXCEPTION 'booking % needs approved credit terms', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A prepayment is confirmed only by a fully paid prepayment invoice (no manual shortcut).
  IF TG_OP = 'UPDATE' AND NEW."payment_status" = 'PAYMENT_CONFIRMED'
    AND OLD."payment_status" IS DISTINCT FROM 'PAYMENT_CONFIRMED'
    AND NOT EXISTS (
      SELECT 1 FROM "invoice" i
      WHERE i."booking_id" = NEW."id" AND i."kind" = 'PREPAYMENT' AND i."status" = 'PAID'
    ) THEN
    RAISE EXCEPTION 'booking % prepayment is not paid', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A refund is final only when no payment of the booking's invoices is still held.
  IF TG_OP = 'UPDATE' AND NEW."payment_status" = 'REFUNDED'
    AND OLD."payment_status" IS DISTINCT FROM 'REFUNDED'
    AND (NOT EXISTS (
      SELECT 1 FROM "payment" p JOIN "invoice" i ON i."id" = p."invoice_id"
      WHERE i."booking_id" = NEW."id" AND p."status" = 'REFUNDED'
    ) OR EXISTS (
      SELECT 1 FROM "payment" p JOIN "invoice" i ON i."id" = p."invoice_id"
      WHERE i."booking_id" = NEW."id" AND p."status" IN ('CONFIRMED', 'REFUND_PENDING')
    )) THEN
    RAISE EXCEPTION 'booking % still holds payments', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_credit_guard
  BEFORE INSERT OR UPDATE OF "payment_requirement", "payment_status" ON "booking"
  FOR EACH ROW EXECUTE FUNCTION isela_booking_credit_guard();
--> statement-breakpoint
-- Job payment guard (day 5), extended: a job on credit terms also needs a still valid approval,
-- no overdue invoice of the customer and no pending payment review of the booking.
CREATE OR REPLACE FUNCTION isela_job_payment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'IN_PROGRESS' AND OLD."status" IS DISTINCT FROM 'IN_PROGRESS' AND NOT EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = NEW."booking_id"
      AND b."status" IN ('CONFIRMED', 'SCHEDULED')
      AND b."payment_review_required" = false
      AND (
        (b."payment_requirement" = 'CREDIT_TERMS_APPROVED' AND isela_customer_credit_ok(b."customer_id"))
        OR b."payment_status" = 'PAYMENT_CONFIRMED'
      )
  ) THEN
    RAISE EXCEPTION 'job % cannot start: booking not confirmed or prepayment missing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
