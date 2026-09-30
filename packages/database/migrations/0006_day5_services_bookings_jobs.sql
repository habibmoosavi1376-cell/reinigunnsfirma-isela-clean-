CREATE TYPE "public"."service_duration_model" AS ENUM('MANUAL', 'FIXED', 'PER_UNIT');--> statement-breakpoint
CREATE TYPE "public"."service_pricing_strategy" AS ENUM('MANUAL_QUOTE', 'RULE_BASED');--> statement-breakpoint
CREATE TYPE "public"."quote_item_pricing_source" AS ENUM('MANUAL', 'ENGINE', 'ENGINE_OVERRIDDEN');--> statement-breakpoint
CREATE TYPE "public"."price_rule_set_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."pricing_calculation_status" AS ENUM('CALCULATED', 'CONFIG_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."employee_unavailability_kind" AS ENUM('ABSENCE', 'TRAINING', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."partner_document_kind" AS ENUM('TRADE_REGISTRATION', 'LIABILITY_INSURANCE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."partner_document_status" AS ENUM('PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('ACTIVE', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('QUOTE');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('REQUESTED', 'PENDING_PAYMENT', 'CONFIRMED', 'SCHEDULED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('IN_HOUSE', 'PARTNER');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PLANNED', 'ASSIGNMENT_PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'QUALITY_CHECK', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_requirement" AS ENUM('VORKASSE_REQUIRED', 'CREDIT_TERMS_APPROVED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PAYMENT_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUNDED');--> statement-breakpoint
CREATE TABLE "service_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_option_service_key_uq" UNIQUE("service_id","key"),
	CONSTRAINT "service_option_key_chk" CHECK ("service_option"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "price_rule_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"service_area_id" uuid,
	"status" "price_rule_set_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"rules" jsonb NOT NULL,
	"change_reason" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"activated_by_user_id" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_rule_set_version_unique" UNIQUE("version"),
	CONSTRAINT "price_rule_set_version_chk" CHECK ("price_rule_set"."version" >= 1),
	CONSTRAINT "price_rule_set_activation_chk" CHECK ("price_rule_set"."status" = 'DRAFT' OR ("price_rule_set"."activated_at" IS NOT NULL AND "price_rule_set"."activated_by_user_id" IS NOT NULL)),
	CONSTRAINT "price_rule_set_retired_chk" CHECK (("price_rule_set"."status" = 'RETIRED') = ("price_rule_set"."retired_at" IS NOT NULL)),
	CONSTRAINT "price_rule_set_reason_chk" CHECK (length("price_rule_set"."change_reason") BETWEEN 3 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "pricing_calculation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "pricing_calculation_status" NOT NULL,
	"engine_version" text NOT NULL,
	"pricing_version" text,
	"rule_set_id" uuid,
	"service_id" uuid NOT NULL,
	"quote_id" uuid,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"net_cents" bigint,
	"tax_rate_basis_points" integer,
	"tax_cents" bigint,
	"gross_cents" bigint,
	"estimated_labor_minutes" integer,
	"direct_costs_cents" bigint,
	"internal_cost_cents" bigint,
	"contribution_margin_cents" bigint,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_calculation_amounts_chk" CHECK ("pricing_calculation"."status" <> 'CALCULATED' OR (
        "pricing_calculation"."net_cents" > 0 AND "pricing_calculation"."tax_cents" >= 0 AND "pricing_calculation"."gross_cents" = "pricing_calculation"."net_cents" + "pricing_calculation"."tax_cents" AND
        "pricing_calculation"."tax_rate_basis_points" BETWEEN 0 AND 10000 AND "pricing_calculation"."pricing_version" IS NOT NULL AND
        "pricing_calculation"."rule_set_id" IS NOT NULL AND "pricing_calculation"."estimated_labor_minutes" >= 0 AND "pricing_calculation"."direct_costs_cents" >= 0
      )),
	CONSTRAINT "pricing_calculation_config_required_chk" CHECK ("pricing_calculation"."status" <> 'CONFIG_REQUIRED' OR ("pricing_calculation"."net_cents" IS NULL AND "pricing_calculation"."gross_cents" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"qualifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_latitude" numeric(9, 6),
	"base_longitude" numeric(9, 6),
	"base_location" "geo_point" GENERATED ALWAYS AS (CASE WHEN base_latitude IS NOT NULL AND base_longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(base_longitude::double precision, base_latitude::double precision), 4326)::geography END) STORED,
	"max_jobs_per_day" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "employee_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "employee_name_chk" CHECK (length("employee"."display_name") BETWEEN 1 AND 200),
	CONSTRAINT "employee_coordinates_chk" CHECK (("employee"."base_latitude" IS NULL) = ("employee"."base_longitude" IS NULL) AND
        ("employee"."base_latitude" IS NULL OR ("employee"."base_latitude" BETWEEN -90 AND 90 AND "employee"."base_longitude" BETWEEN -180 AND 180))),
	CONSTRAINT "employee_capacity_chk" CHECK ("employee"."max_jobs_per_day" IS NULL OR "employee"."max_jobs_per_day" BETWEEN 1 AND 50),
	CONSTRAINT "employee_qualifications_chk" CHECK (cardinality("employee"."qualifications") <= 50)
);
--> statement-breakpoint
CREATE TABLE "employee_service_area" (
	"employee_id" uuid NOT NULL,
	"service_area_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_service_area_employee_id_service_area_id_pk" PRIMARY KEY("employee_id","service_area_id")
);
--> statement-breakpoint
CREATE TABLE "employee_unavailability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" "employee_unavailability_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_unavailability_period_chk" CHECK ("employee_unavailability"."ends_at" > "employee_unavailability"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "employee_working_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_working_window_weekday_chk" CHECK ("employee_working_window"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "employee_working_window_minutes_chk" CHECK ("employee_working_window"."start_minute" BETWEEN 0 AND 1439 AND "employee_working_window"."end_minute" BETWEEN 1 AND 1440 AND "employee_working_window"."end_minute" > "employee_working_window"."start_minute")
);
--> statement-breakpoint
CREATE TABLE "partner_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"kind" "partner_document_kind" NOT NULL,
	"status" "partner_document_status" DEFAULT 'PENDING' NOT NULL,
	"reference" text,
	"valid_until" date,
	"verified_by_user_id" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_document_verified_chk" CHECK ("partner_document"."status" = 'PENDING' OR ("partner_document"."verified_at" IS NOT NULL AND "partner_document"."verified_by_user_id" IS NOT NULL)),
	CONSTRAINT "partner_document_reference_chk" CHECK ("partner_document"."reference" IS NULL OR length("partner_document"."reference") <= 100)
);
--> statement-breakpoint
CREATE TABLE "partner_service" (
	"partner_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_service_partner_id_service_id_pk" PRIMARY KEY("partner_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"quote_id" uuid,
	"source" "booking_source" NOT NULL,
	"status" "booking_status" DEFAULT 'REQUESTED' NOT NULL,
	"requested_date" date NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"net_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"payment_requirement" "payment_requirement" NOT NULL,
	"payment_status" "payment_status",
	"payment_decision" jsonb NOT NULL,
	"operational_notes" text,
	"cancellation_reason" text,
	"created_by_user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "booking_window_chk" CHECK ("booking"."window_end" > "booking"."window_start"),
	CONSTRAINT "booking_duration_chk" CHECK ("booking"."duration_minutes" > 0 AND "booking"."duration_minutes" * interval '1 minute' <= "booking"."window_end" - "booking"."window_start"),
	CONSTRAINT "booking_amounts_chk" CHECK ("booking"."net_cents" > 0 AND "booking"."tax_cents" >= 0 AND "booking"."gross_cents" = "booking"."net_cents" + "booking"."tax_cents"),
	CONSTRAINT "booking_source_chk" CHECK ("booking"."source" <> 'QUOTE' OR "booking"."quote_id" IS NOT NULL),
	CONSTRAINT "booking_payment_status_chk" CHECK (("booking"."payment_requirement" = 'VORKASSE_REQUIRED') = ("booking"."payment_status" IS NOT NULL)),
	CONSTRAINT "booking_prepayment_guard_chk" CHECK ("booking"."payment_requirement" <> 'VORKASSE_REQUIRED' OR "booking"."status" IN ('REQUESTED', 'PENDING_PAYMENT', 'CANCELLED') OR
        "booking"."payment_status" IN ('PAYMENT_CONFIRMED', 'REFUND_PENDING', 'REFUNDED')),
	CONSTRAINT "booking_pending_payment_chk" CHECK ("booking"."status" <> 'PENDING_PAYMENT' OR "booking"."payment_requirement" = 'VORKASSE_REQUIRED'),
	CONSTRAINT "booking_cancel_chk" CHECK (("booking"."status" = 'CANCELLED') = ("booking"."cancelled_at" IS NOT NULL AND "booking"."cancellation_reason" IS NOT NULL)),
	CONSTRAINT "booking_text_chk" CHECK (("booking"."operational_notes" IS NULL OR length("booking"."operational_notes") <= 2000) AND
        ("booking"."cancellation_reason" IS NULL OR length("booking"."cancellation_reason") <= 1000)),
	CONSTRAINT "booking_version_chk" CHECK ("booking"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "booking_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"quote_item_id" uuid,
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
	CONSTRAINT "booking_item_position_uq" UNIQUE("booking_id","position"),
	CONSTRAINT "booking_item_quantity_chk" CHECK ("booking_item"."quantity" > 0),
	CONSTRAINT "booking_item_amounts_chk" CHECK ("booking_item"."unit_price_cents" >= 0 AND "booking_item"."net_cents" >= 0 AND "booking_item"."tax_cents" >= 0 AND "booking_item"."gross_cents" = "booking_item"."net_cents" + "booking_item"."tax_cents")
);
--> statement-breakpoint
CREATE TABLE "booking_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" "booking_status",
	"to_status" "booking_status" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_status_transition_change_chk" CHECK ("booking_status_transition"."from_status" IS NULL OR "booking_status_transition"."from_status" <> "booking_status_transition"."to_status")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'PLANNED' NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"service_area_id" uuid,
	"required_qualifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"fulfillment_type" "fulfillment_type",
	"operational_notes" text,
	"created_by_user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "job_booking_uq" UNIQUE("booking_id"),
	CONSTRAINT "job_schedule_chk" CHECK ("job"."scheduled_end" > "job"."scheduled_start"),
	CONSTRAINT "job_fulfillment_chk" CHECK ("job"."status" IN ('PLANNED', 'ASSIGNMENT_PENDING', 'CANCELLED') OR "job"."fulfillment_type" IS NOT NULL),
	CONSTRAINT "job_notes_chk" CHECK ("job"."operational_notes" IS NULL OR length("job"."operational_notes") <= 2000),
	CONSTRAINT "job_version_chk" CHECK ("job"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "job_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"employee_id" uuid,
	"partner_id" uuid,
	"status" "assignment_status" DEFAULT 'ACTIVE' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"score" integer,
	"factors" jsonb NOT NULL,
	"assigned_by_user_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" text,
	"release_reason" text,
	CONSTRAINT "job_assignment_target_chk" CHECK (("job_assignment"."employee_id" IS NULL) <> ("job_assignment"."partner_id" IS NULL)),
	CONSTRAINT "job_assignment_period_chk" CHECK ("job_assignment"."ends_at" > "job_assignment"."starts_at"),
	CONSTRAINT "job_assignment_score_chk" CHECK ("job_assignment"."score" IS NULL OR "job_assignment"."score" BETWEEN 0 AND 100),
	CONSTRAINT "job_assignment_release_chk" CHECK (("job_assignment"."status" = 'RELEASED') = ("job_assignment"."released_at" IS NOT NULL AND "job_assignment"."released_by_user_id" IS NOT NULL AND "job_assignment"."release_reason" IS NOT NULL)),
	CONSTRAINT "job_assignment_reason_chk" CHECK ("job_assignment"."release_reason" IS NULL OR length("job_assignment"."release_reason") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "job_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_status" "job_status",
	"to_status" "job_status" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_status_transition_change_chk" CHECK ("job_status_transition"."from_status" IS NULL OR "job_status_transition"."from_status" <> "job_status_transition"."to_status")
);
--> statement-breakpoint
CREATE TABLE "payment_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" "payment_status",
	"to_status" "payment_status" NOT NULL,
	"actor_user_id" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_status_transition_change_chk" CHECK ("payment_status_transition"."from_status" IS NULL OR "payment_status_transition"."from_status" <> "payment_status_transition"."to_status"),
	CONSTRAINT "payment_status_transition_reference_chk" CHECK ("payment_status_transition"."reference" IS NULL OR length("payment_status_transition"."reference") <= 200)
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "sort_order" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "min_quantity" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "duration_model" "service_duration_model" DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "base_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "duration_per_unit_seconds" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "pricing_strategy" "service_pricing_strategy" DEFAULT 'MANUAL_QUOTE' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "required_qualifications" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "supported_property_types" "property_type"[] DEFAULT '{}'::property_type[] NOT NULL;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "verified_by_user_id" text;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "max_concurrent_jobs" integer;--> statement-breakpoint
ALTER TABLE "quote_item" ADD COLUMN "pricing_source" "quote_item_pricing_source" DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_item" ADD COLUMN "pricing_calculation_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_item" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "service_option" ADD CONSTRAINT "service_option_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_set" ADD CONSTRAINT "price_rule_set_service_area_id_service_area_id_fk" FOREIGN KEY ("service_area_id") REFERENCES "public"."service_area"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_set" ADD CONSTRAINT "price_rule_set_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_set" ADD CONSTRAINT "price_rule_set_activated_by_user_id_user_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_calculation" ADD CONSTRAINT "pricing_calculation_rule_set_id_price_rule_set_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."price_rule_set"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_calculation" ADD CONSTRAINT "pricing_calculation_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_calculation" ADD CONSTRAINT "pricing_calculation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_service_area" ADD CONSTRAINT "employee_service_area_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_service_area" ADD CONSTRAINT "employee_service_area_service_area_id_service_area_id_fk" FOREIGN KEY ("service_area_id") REFERENCES "public"."service_area"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_unavailability" ADD CONSTRAINT "employee_unavailability_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_unavailability" ADD CONSTRAINT "employee_unavailability_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_working_window" ADD CONSTRAINT "employee_working_window_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_document" ADD CONSTRAINT "partner_document_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_document" ADD CONSTRAINT "partner_document_verified_by_user_id_user_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service" ADD CONSTRAINT "partner_service_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service" ADD CONSTRAINT "partner_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_address_id_customer_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_address"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_item" ADD CONSTRAINT "booking_item_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_item" ADD CONSTRAINT "booking_item_quote_item_id_quote_item_id_fk" FOREIGN KEY ("quote_item_id") REFERENCES "public"."quote_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_item" ADD CONSTRAINT "booking_item_service_category_id_service_category_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_item" ADD CONSTRAINT "booking_item_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_status_transition" ADD CONSTRAINT "booking_status_transition_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_service_area_id_service_area_id_fk" FOREIGN KEY ("service_area_id") REFERENCES "public"."service_area"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_assigned_by_user_id_user_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_transition" ADD CONSTRAINT "job_status_transition_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_status_transition" ADD CONSTRAINT "payment_status_transition_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_rule_set_active_default_uq" ON "price_rule_set" USING btree ("status") WHERE "price_rule_set"."status" = 'ACTIVE' AND "price_rule_set"."service_area_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "price_rule_set_active_area_uq" ON "price_rule_set" USING btree ("service_area_id") WHERE "price_rule_set"."status" = 'ACTIVE' AND "price_rule_set"."service_area_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pricing_calculation_quote_idx" ON "pricing_calculation" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "employee_unavailability_employee_idx" ON "employee_unavailability" USING btree ("employee_id","starts_at");--> statement-breakpoint
CREATE INDEX "employee_working_window_employee_idx" ON "employee_working_window" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "partner_document_partner_idx" ON "partner_document" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_service_service_idx" ON "partner_service" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_quote_uq" ON "booking" USING btree ("quote_id") WHERE "booking"."quote_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "booking_customer_window_idx" ON "booking" USING btree ("customer_id","window_start");--> statement-breakpoint
CREATE INDEX "booking_status_window_idx" ON "booking" USING btree ("status","window_start");--> statement-breakpoint
CREATE INDEX "booking_status_transition_booking_idx" ON "booking_status_transition" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "job_status_start_idx" ON "job" USING btree ("status","scheduled_start");--> statement-breakpoint
CREATE UNIQUE INDEX "job_assignment_active_job_uq" ON "job_assignment" USING btree ("job_id") WHERE "job_assignment"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "job_assignment_partner_active_idx" ON "job_assignment" USING btree ("partner_id","starts_at") WHERE "job_assignment"."status" = 'ACTIVE' AND "job_assignment"."partner_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_status_transition_job_idx" ON "job_status_transition" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "payment_status_transition_booking_idx" ON "payment_status_transition" USING btree ("booking_id");--> statement-breakpoint
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_pricing_calculation_id_pricing_calculation_id_fk" FOREIGN KEY ("pricing_calculation_id") REFERENCES "public"."pricing_calculation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-edited: NOT VALID (checked for new/changed rows) so the upgrade never aborts on legacy keys.
ALTER TABLE "service" ADD CONSTRAINT "service_key_chk" CHECK ("service"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_min_quantity_chk" CHECK ("service"."min_quantity" IS NULL OR "service"."min_quantity" > 0);--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_duration_chk" CHECK (("service"."base_duration_minutes" IS NULL OR "service"."base_duration_minutes" BETWEEN 0 AND 10080) AND
        ("service"."duration_per_unit_seconds" IS NULL OR "service"."duration_per_unit_seconds" BETWEEN 1 AND 86400) AND
        ("service"."duration_model" <> 'FIXED' OR "service"."base_duration_minutes" IS NOT NULL) AND
        ("service"."duration_model" <> 'PER_UNIT' OR "service"."duration_per_unit_seconds" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_lists_chk" CHECK (cardinality("service"."required_qualifications") <= 20 AND cardinality("service"."supported_property_types") <= 20);--> statement-breakpoint
ALTER TABLE "partner" ADD CONSTRAINT "partner_capacity_chk" CHECK ("partner"."max_concurrent_jobs" IS NULL OR "partner"."max_concurrent_jobs" BETWEEN 1 AND 1000);--> statement-breakpoint
-- Hand-edited: NOT VALID – legacy ACTIVE partners without verification stay readable but are
-- never assignable (the assignment rules require verified_at); VALIDATE after owner review.
ALTER TABLE "partner" ADD CONSTRAINT "partner_active_verified_chk" CHECK ("partner"."status" <> 'ACTIVE' OR ("partner"."verified_at" IS NOT NULL AND "partner"."verified_by_user_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
-- Hand-edited: NOT VALID – new or changed rows can never be released with 0 EUR; legacy rows are
-- reported by the upgrade test instead of aborting the migration.
ALTER TABLE "quote" ADD CONSTRAINT "quote_released_amount_chk" CHECK ("quote"."status" NOT IN ('PENDING_REVIEW', 'SENT', 'ACCEPTED') OR "quote"."gross_cents" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_pricing_source_chk" CHECK (("quote_item"."pricing_source" = 'MANUAL') = ("quote_item"."pricing_calculation_id" IS NULL AND "quote_item"."pricing_version" IS NULL));--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Hand-written integrity guards (day 5). Defence in depth to the domain services.
-- ---------------------------------------------------------------------------------------------
-- Status histories, pricing calculations and booking items are evidence: append-only.
CREATE TRIGGER booking_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "booking_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER payment_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "payment_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER job_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "job_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER pricing_calculation_append_only
  BEFORE UPDATE OR DELETE ON "pricing_calculation"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER booking_item_append_only
  BEFORE UPDATE OR DELETE ON "booking_item"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
-- A rule set is editable only as DRAFT. Once ACTIVE its content is frozen; the only allowed
-- changes are ACTIVE -> RETIRED (with retired_at). Non-draft rule sets cannot be deleted.
CREATE OR REPLACE FUNCTION isela_price_rule_set_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'price_rule_set % is not a draft and cannot be deleted', OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."rules" IS DISTINCT FROM OLD."rules" OR NEW."version" IS DISTINCT FROM OLD."version" OR
    NEW."service_area_id" IS DISTINCT FROM OLD."service_area_id" OR
    NEW."currency" IS DISTINCT FROM OLD."currency" OR
    NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id" OR
    NEW."activated_at" IS DISTINCT FROM OLD."activated_at" OR
    NEW."activated_by_user_id" IS DISTINCT FROM OLD."activated_by_user_id"
  ) THEN
    RAISE EXCEPTION 'price_rule_set % is immutable once activated', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'RETIRED' OR (OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'RETIRED')) THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'price_rule_set status % -> % not allowed', OLD."status", NEW."status"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_rule_set_guard
  BEFORE UPDATE OR DELETE ON "price_rule_set"
  FOR EACH ROW EXECUTE FUNCTION isela_price_rule_set_guard();
--> statement-breakpoint
-- A booking's property, address and quote must belong to the booking's customer, and the
-- address must be the property's address.
CREATE OR REPLACE FUNCTION isela_booking_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = NEW."property_id" AND p."customer_id" = NEW."customer_id"
      AND p."address_id" = NEW."address_id"
  ) THEN
    RAISE EXCEPTION 'booking.property_id/address_id must belong to booking.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."quote_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "quote" q
    WHERE q."id" = NEW."quote_id" AND q."customer_id" = NEW."customer_id"
  ) THEN
    RAISE EXCEPTION 'booking.quote_id must belong to booking.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_owner
  BEFORE INSERT OR UPDATE OF "customer_id", "property_id", "address_id", "quote_id" ON "booking"
  FOR EACH ROW EXECUTE FUNCTION isela_booking_owner_check();
--> statement-breakpoint
-- No double booking of an employee: ACTIVE assignments of the same employee must not overlap.
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_employee_no_overlap_excl" EXCLUDE USING gist (
  "employee_id" WITH =,
  tstzrange("starts_at", "ends_at", '[)') WITH &&
) WHERE ("status" = 'ACTIVE' AND "employee_id" IS NOT NULL);
--> statement-breakpoint
-- Assignments are evidence: only the release of an ACTIVE assignment may change a row.
CREATE OR REPLACE FUNCTION isela_job_assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job_assignment is append-only (DELETE not allowed)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' OR NEW."status" <> 'RELEASED' OR
    NEW."job_id" IS DISTINCT FROM OLD."job_id" OR
    NEW."employee_id" IS DISTINCT FROM OLD."employee_id" OR
    NEW."partner_id" IS DISTINCT FROM OLD."partner_id" OR
    NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at" OR
    NEW."score" IS DISTINCT FROM OLD."score" OR NEW."factors" IS DISTINCT FROM OLD."factors" OR
    NEW."assigned_by_user_id" IS DISTINCT FROM OLD."assigned_by_user_id" OR
    NEW."assigned_at" IS DISTINCT FROM OLD."assigned_at"
  THEN
    RAISE EXCEPTION 'job_assignment may only be released'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_assignment_guard
  BEFORE UPDATE OR DELETE ON "job_assignment"
  FOR EACH ROW EXECUTE FUNCTION isela_job_assignment_guard();
--> statement-breakpoint
-- Payment guard: a job may only start when its booking is confirmed or scheduled and, for
-- prepayment bookings, the payment is confirmed (explicit credit terms need no prepayment).
CREATE OR REPLACE FUNCTION isela_job_payment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'IN_PROGRESS' AND OLD."status" IS DISTINCT FROM 'IN_PROGRESS' AND NOT EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = NEW."booking_id"
      AND b."status" IN ('CONFIRMED', 'SCHEDULED')
      AND (b."payment_requirement" = 'CREDIT_TERMS_APPROVED' OR b."payment_status" = 'PAYMENT_CONFIRMED')
  ) THEN
    RAISE EXCEPTION 'job % cannot start: booking not confirmed or prepayment missing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_payment_guard
  BEFORE UPDATE OF "status" ON "job"
  FOR EACH ROW EXECUTE FUNCTION isela_job_payment_guard();
