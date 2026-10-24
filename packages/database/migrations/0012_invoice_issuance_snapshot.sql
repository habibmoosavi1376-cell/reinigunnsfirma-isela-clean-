ALTER TABLE "invoice" ADD COLUMN "service_date" date;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "service_date_basis" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "recipient_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "issuer_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_service_date_basis_chk" CHECK ("invoice"."service_date_basis" IS NULL OR "invoice"."service_date_basis" IN ('PLANNED', 'PERFORMED'));--> statement-breakpoint
-- Migration 0012: the issuance snapshot (service date, recipient, issuer) is required for
-- every newly issued invoice and frozen afterwards. Invoices issued before stay unchanged.
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
    OR NEW."issued_by_user_id" IS DISTINCT FROM OLD."issued_by_user_id"
    OR NEW."service_date" IS DISTINCT FROM OLD."service_date"
    OR NEW."service_date_basis" IS DISTINCT FROM OLD."service_date_basis"
    OR NEW."recipient_snapshot" IS DISTINCT FROM OLD."recipient_snapshot"
    OR NEW."issuer_snapshot" IS DISTINCT FROM OLD."issuer_snapshot") THEN
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
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' AND (
    NEW."service_date" IS NULL OR NEW."service_date_basis" IS NULL
    OR NEW."recipient_snapshot" IS NULL OR NEW."issuer_snapshot" IS NULL) THEN
    RAISE EXCEPTION 'invoice % needs service date, recipient and issuer at issuance', NEW."id"
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
