CREATE TYPE "public"."request_customer_type" AS ENUM('PRIVATE', 'BUSINESS', 'PROPERTY_MANAGEMENT');--> statement-breakpoint
CREATE TYPE "public"."request_frequency" AS ENUM('ONCE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."service_area_status" AS ENUM('UNKNOWN', 'IN_AREA', 'OUTSIDE');--> statement-breakpoint
CREATE TABLE "public_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"customer_id" uuid,
	"submitted_by_user_id" text,
	"customer_type" "request_customer_type" NOT NULL,
	"service_category_id" uuid NOT NULL,
	"property_type" "property_type" NOT NULL,
	"approximate_area_sqm" numeric(10, 2),
	"frequency" "request_frequency" NOT NULL,
	"message" text,
	"street" text NOT NULL,
	"house_number" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"country" char(2) DEFAULT 'DE' NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"location" "geo_point" GENERATED ALWAYS AS (CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography END) STORED,
	"geocoding_status" "geocoding_status" DEFAULT 'PENDING' NOT NULL,
	"service_area_status" "service_area_status" DEFAULT 'UNKNOWN' NOT NULL,
	"privacy_notice_version" text NOT NULL,
	"privacy_notice_acknowledged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_request_area_chk" CHECK ("service_request"."approximate_area_sqm" IS NULL OR "service_request"."approximate_area_sqm" > 0),
	CONSTRAINT "service_request_message_chk" CHECK ("service_request"."message" IS NULL OR length("service_request"."message") <= 2000),
	CONSTRAINT "service_request_coordinates_chk" CHECK (("service_request"."latitude" IS NULL) = ("service_request"."longitude" IS NULL)),
	CONSTRAINT "service_request_area_status_chk" CHECK ("service_request"."service_area_status" = 'UNKNOWN' OR "service_request"."latitude" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "service_category" ADD COLUMN "url_slug" text;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_service_category_id_service_category_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_request_lead_uq" ON "service_request" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "service_request_customer_idx" ON "service_request" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "service_request_created_idx" ON "service_request" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_url_slug_unique" UNIQUE("url_slug");