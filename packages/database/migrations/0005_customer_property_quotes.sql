CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'PENDING_REVIEW', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"lead_id" uuid,
	"status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"valid_until" date,
	"notes" text,
	"created_by_user_id" text NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_amounts_chk" CHECK ("quote"."net_cents" >= 0 AND "quote"."tax_cents" >= 0 AND "quote"."gross_cents" = "quote"."net_cents" + "quote"."tax_cents"),
	CONSTRAINT "quote_notes_chk" CHECK ("quote"."notes" IS NULL OR length("quote"."notes") <= 4000),
	CONSTRAINT "quote_sent_chk" CHECK ("quote"."status" IN ('DRAFT', 'PENDING_REVIEW', 'CANCELLED') OR ("quote"."valid_until" IS NOT NULL AND "quote"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "quote_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"service_category_id" uuid NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit" "service_unit" NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"net_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_item_position_uq" UNIQUE("quote_id","position"),
	CONSTRAINT "quote_item_position_chk" CHECK ("quote_item"."position" >= 1),
	CONSTRAINT "quote_item_quantity_chk" CHECK ("quote_item"."quantity" > 0),
	CONSTRAINT "quote_item_amounts_chk" CHECK ("quote_item"."unit_price_cents" >= 0 AND "quote_item"."net_cents" >= 0 AND "quote_item"."tax_cents" >= 0 AND "quote_item"."gross_cents" = "quote_item"."net_cents" + "quote_item"."tax_cents"),
	CONSTRAINT "quote_item_tax_chk" CHECK ("quote_item"."tax_rate_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "quote_item_description_chk" CHECK (length("quote_item"."description") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "quote_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"from_status" "quote_status" NOT NULL,
	"to_status" "quote_status" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_status_transition_change_chk" CHECK ("quote_status_transition"."from_status" <> "quote_status_transition"."to_status")
);
--> statement-breakpoint
-- Hand-edited (non-destructive): drizzle-kit generated DROP/CREATE TYPE with casts, which
-- would fail for existing 'HOUSE' rows. RENAME VALUE keeps every row; new values are appended
-- (not used within this migration's transaction).
ALTER TYPE "public"."property_type" RENAME VALUE 'HOUSE' TO 'PRIVATE_HOME';--> statement-breakpoint
ALTER TYPE "public"."property_type" ADD VALUE 'RETAIL';--> statement-breakpoint
ALTER TYPE "public"."property_type" ADD VALUE 'GASTRONOMY';--> statement-breakpoint
ALTER TYPE "public"."property_type" ADD VALUE 'GYM';--> statement-breakpoint
ALTER TYPE "public"."property_type" ADD VALUE 'HOLIDAY_RENTAL';--> statement-breakpoint
ALTER TYPE "public"."property_type" ADD VALUE 'PROPERTY_MANAGEMENT';--> statement-breakpoint
ALTER TABLE "customer_address" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_address" ADD COLUMN "normalized_key" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "rooms" integer;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "bathrooms" integer;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "service_frequency" "request_frequency";--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "service_requirements" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "customer_address_id" uuid;--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_service_category_id_service_category_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_status_transition" ADD CONSTRAINT "quote_status_transition_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_customer_idx" ON "quote" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quote_status_idx" ON "quote" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quote_lead_idx" ON "quote" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "quote_status_transition_quote_idx" ON "quote_status_transition" USING btree ("quote_id");--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_customer_address_id_customer_address_id_fk" FOREIGN KEY ("customer_address_id") REFERENCES "public"."customer_address"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_address_primary_uq" ON "customer_address" USING btree ("customer_id") WHERE "customer_address"."is_primary" AND "customer_address"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_address_dedupe_uq" ON "customer_address" USING btree ("customer_id","address_type","normalized_key") WHERE "customer_address"."archived_at" IS NULL AND "customer_address"."normalized_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_rooms_chk" CHECK ("property"."rooms" IS NULL OR "property"."rooms" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_bathrooms_chk" CHECK ("property"."bathrooms" IS NULL OR "property"."bathrooms" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_text_chk" CHECK (("property"."service_requirements" IS NULL OR length("property"."service_requirements") <= 2000) AND ("property"."notes" IS NULL OR length("property"."notes") <= 2000));--> statement-breakpoint
-- Quote status history is evidence: append-only like audit/consent/lead transitions.
CREATE TRIGGER quote_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "quote_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
-- A quote's property must belong to the quote's customer (defence in depth to the service).
CREATE OR REPLACE FUNCTION isela_quote_property_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."property_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = NEW."property_id" AND p."customer_id" = NEW."customer_id"
  ) THEN
    RAISE EXCEPTION 'quote.property_id must belong to quote.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quote_property_owner
  BEFORE INSERT OR UPDATE OF "customer_id", "property_id" ON "quote"
  FOR EACH ROW EXECUTE FUNCTION isela_quote_property_owner_check();
--> statement-breakpoint
-- Address/property derived from a request must belong to the request's customer.
CREATE OR REPLACE FUNCTION isela_service_request_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customer_address_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "customer_address" a
    WHERE a."id" = NEW."customer_address_id" AND a."customer_id" = NEW."customer_id"
  ) THEN
    RAISE EXCEPTION 'service_request.customer_address_id must belong to service_request.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."property_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = NEW."property_id" AND p."customer_id" = NEW."customer_id"
  ) THEN
    RAISE EXCEPTION 'service_request.property_id must belong to service_request.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER service_request_owner
  BEFORE INSERT OR UPDATE OF "customer_id", "customer_address_id", "property_id" ON "service_request"
  FOR EACH ROW EXECUTE FUNCTION isela_service_request_owner_check();
