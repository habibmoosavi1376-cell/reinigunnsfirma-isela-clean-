CREATE TYPE "public"."landing_page_status" AS ENUM('DRAFT', 'PUBLISHED');--> statement-breakpoint
CREATE TYPE "public"."geocode_precision" AS ENUM('BUILDING', 'STREET', 'POSTCODE', 'CITY', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."geocoding_outcome" AS ENUM('ACCEPTED', 'NEEDS_REVIEW', 'NO_MATCH', 'UNAVAILABLE', 'MANUAL_CONFIRMED', 'MANUAL_REJECTED');--> statement-breakpoint
ALTER TYPE "public"."customer_kind" ADD VALUE 'PROPERTY_MANAGEMENT';--> statement-breakpoint
ALTER TYPE "public"."geocoding_status" ADD VALUE 'NEEDS_REVIEW';--> statement-breakpoint
CREATE TABLE "landing_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_category_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"service_area_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" "landing_page_status" DEFAULT 'DRAFT' NOT NULL,
	"content" jsonb,
	"content_reviewed_at" timestamp with time zone,
	"content_reviewed_by_user_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_page_slug_unique" UNIQUE("slug"),
	CONSTRAINT "landing_page_category_city_uq" UNIQUE("service_category_id","city_id"),
	CONSTRAINT "landing_page_publish_chk" CHECK ("landing_page"."status" = 'DRAFT' OR (
        "landing_page"."content" IS NOT NULL AND "landing_page"."content_reviewed_at" IS NOT NULL AND
        "landing_page"."content_reviewed_by_user_id" IS NOT NULL AND "landing_page"."published_at" IS NOT NULL
      )),
	CONSTRAINT "landing_page_slug_chk" CHECK ("landing_page"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "geocoding_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_request_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"outcome" "geocoding_outcome" NOT NULL,
	"precision" "geocode_precision",
	"confidence" numeric(4, 3),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"street" text,
	"house_number" text,
	"postal_code" text,
	"city" text,
	"region" text,
	"country" char(2),
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"performed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geocoding_attempt_coordinates_chk" CHECK (("geocoding_attempt"."latitude" IS NULL) = ("geocoding_attempt"."longitude" IS NULL)),
	CONSTRAINT "geocoding_attempt_outcome_chk" CHECK (("geocoding_attempt"."outcome" IN ('ACCEPTED', 'NEEDS_REVIEW', 'MANUAL_CONFIRMED')) = ("geocoding_attempt"."latitude" IS NOT NULL)),
	CONSTRAINT "geocoding_attempt_manual_chk" CHECK (("geocoding_attempt"."outcome" IN ('MANUAL_CONFIRMED', 'MANUAL_REJECTED')) = ("geocoding_attempt"."performed_by_user_id" IS NOT NULL)),
	CONSTRAINT "geocoding_attempt_confidence_chk" CHECK ("geocoding_attempt"."confidence" IS NULL OR "geocoding_attempt"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
-- Hand-edited (non-destructive): drizzle-kit generated DROP/CREATE TYPE for the renamed
-- values, which would fail for existing rows. RENAME VALUE keeps every row and its meaning.
ALTER TYPE "public"."service_area_status" RENAME VALUE 'IN_AREA' TO 'AVAILABLE';--> statement-breakpoint
ALTER TYPE "public"."service_area_status" RENAME VALUE 'OUTSIDE' TO 'NOT_AVAILABLE';--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "number_of_properties" integer;--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "service_area_id" uuid;--> statement-breakpoint
ALTER TABLE "service_request" ADD COLUMN "service_area_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_service_category_id_service_category_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_service_area_id_service_area_id_fk" FOREIGN KEY ("service_area_id") REFERENCES "public"."service_area"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geocoding_attempt" ADD CONSTRAINT "geocoding_attempt_service_request_id_service_request_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geocoding_attempt_request_idx" ON "geocoding_attempt" USING btree ("service_request_id","created_at");--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_service_area_id_service_area_id_fk" FOREIGN KEY ("service_area_id") REFERENCES "public"."service_area"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_one_customer_per_user_uq" ON "user_role" USING btree ("user_id") WHERE "user_role"."role_key" = 'CUSTOMER';--> statement-breakpoint
CREATE INDEX "lead_created_idx" ON "lead" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "service_request_service_area_idx" ON "service_request" USING btree ("service_area_id");--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_area_id_chk" CHECK (("service_request"."service_area_status" = 'AVAILABLE') = ("service_request"."service_area_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_geocoded_chk" CHECK (("service_request"."geocoding_status" IN ('SUCCEEDED', 'MANUAL')) = ("service_request"."latitude" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_properties_chk" CHECK ("service_request"."number_of_properties" IS NULL OR ("service_request"."number_of_properties" BETWEEN 1 AND 100000 AND "service_request"."customer_type" = 'PROPERTY_MANAGEMENT'));--> statement-breakpoint
-- Geocoding history is evidence for availability decisions: append-only like audit/consent.
CREATE TRIGGER geocoding_attempt_append_only
  BEFORE UPDATE OR DELETE ON "geocoding_attempt"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
