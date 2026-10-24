CREATE TYPE "public"."contract_status" AS ENUM('ACTIVE', 'PAUSED', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_skip_reason" AS ENUM('HOLIDAY', 'PAUSED', 'INVALID_LOCAL_TIME');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('BOOKED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."recurrence_frequency" AS ENUM('WEEKLY', 'BIWEEKLY', 'MONTHLY');--> statement-breakpoint
ALTER TYPE "public"."booking_source" ADD VALUE 'CONTRACT';--> statement-breakpoint
CREATE TABLE "contract_occurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"status" "occurrence_status" NOT NULL,
	"skip_reason" "occurrence_skip_reason",
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_occurrence_day_uq" UNIQUE("contract_id","occurrence_date"),
	CONSTRAINT "contract_occurrence_state_chk" CHECK (("contract_occurrence"."status" = 'BOOKED' AND "contract_occurrence"."booking_id" IS NOT NULL AND "contract_occurrence"."skip_reason" IS NULL) OR
        ("contract_occurrence"."status" = 'SKIPPED' AND "contract_occurrence"."booking_id" IS NULL AND "contract_occurrence"."skip_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "contract_pause" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_pause_dates_chk" CHECK ("contract_pause"."to_date" >= "contract_pause"."from_date"),
	CONSTRAINT "contract_pause_reason_chk" CHECK (length("contract_pause"."reason") BETWEEN 3 AND 500)
);
--> statement-breakpoint
CREATE TABLE "holiday_year_coverage" (
	"region" text NOT NULL,
	"year" integer NOT NULL,
	"source_reference" text NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_year_coverage_region_year_pk" PRIMARY KEY("region","year"),
	CONSTRAINT "holiday_year_coverage_year_chk" CHECK ("holiday_year_coverage"."year" BETWEEN 2000 AND 2100),
	CONSTRAINT "holiday_year_coverage_source_chk" CHECK (length("holiday_year_coverage"."source_reference") BETWEEN 5 AND 500)
);
--> statement-breakpoint
CREATE TABLE "public_holiday" (
	"region" text NOT NULL,
	"holiday_date" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_holiday_region_holiday_date_pk" PRIMARY KEY("region","holiday_date"),
	CONSTRAINT "public_holiday_region_chk" CHECK ("public_holiday"."region" ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
	CONSTRAINT "public_holiday_name_chk" CHECK (length("public_holiday"."name") BETWEEN 2 AND 200)
);
--> statement-breakpoint
CREATE TABLE "service_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"frequency" "recurrence_frequency" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"window_start_minute" integer NOT NULL,
	"window_end_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" "contract_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_contract_window_chk" CHECK ("service_contract"."window_start_minute" >= 0 AND "service_contract"."window_start_minute" < "service_contract"."window_end_minute" AND "service_contract"."window_end_minute" <= 1440),
	CONSTRAINT "service_contract_duration_chk" CHECK ("service_contract"."duration_minutes" >= 15 AND "service_contract"."duration_minutes" <= "service_contract"."window_end_minute" - "service_contract"."window_start_minute"),
	CONSTRAINT "service_contract_dates_chk" CHECK ("service_contract"."end_date" IS NULL OR "service_contract"."end_date" >= "service_contract"."start_date"),
	CONSTRAINT "service_contract_monthly_chk" CHECK ("service_contract"."frequency" <> 'MONTHLY' OR extract(day from "service_contract"."start_date") <= 28),
	CONSTRAINT "service_contract_version_chk" CHECK ("service_contract"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "contract_occurrence" ADD CONSTRAINT "contract_occurrence_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_occurrence" ADD CONSTRAINT "contract_occurrence_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_pause" ADD CONSTRAINT "contract_pause_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_pause" ADD CONSTRAINT "contract_pause_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_year_coverage" ADD CONSTRAINT "holiday_year_coverage_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_occurrence_booking_uq" ON "contract_occurrence" USING btree ("booking_id") WHERE "contract_occurrence"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contract_pause_contract_idx" ON "contract_pause" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_contract_quote_uq" ON "service_contract" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "service_contract_customer_idx" ON "service_contract" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_contract_source_chk" CHECK ("booking"."source"::text <> 'CONTRACT' OR "booking"."quote_id" IS NULL);