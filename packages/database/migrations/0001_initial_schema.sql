CREATE TYPE "public"."service_area_kind" AS ENUM('CIRCLE', 'POLYGON');--> statement-breakpoint
CREATE TYPE "public"."service_unit" AS ENUM('HOUR', 'SQUARE_METER', 'FLAT', 'UNIT');--> statement-breakpoint
CREATE TYPE "public"."address_source" AS ENUM('CUSTOMER_INPUT', 'STAFF_INPUT', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."address_type" AS ENUM('BILLING', 'SERVICE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."address_verification_status" AS ENUM('UNVERIFIED', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."customer_identity_kind" AS ENUM('EMAIL', 'PHONE', 'TAX_ID', 'PAYMENT_REFERENCE', 'ADDRESS');--> statement-breakpoint
CREATE TYPE "public"."customer_kind" AS ENUM('PRIVATE', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('ACTIVE', 'INACTIVE', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."duplicate_candidate_status" AS ENUM('OPEN', 'CONFIRMED_SAME', 'CONFIRMED_DIFFERENT');--> statement-breakpoint
CREATE TYPE "public"."duplicate_review_status" AS ENUM('NONE', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."geocoding_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."partner_status" AS ENUM('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('APARTMENT', 'HOUSE', 'OFFICE', 'PRACTICE', 'STAIRWELL', 'COMMERCIAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."contact_consent_status" AS ENUM('NOT_REQUIRED', 'UNKNOWN', 'GRANTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."lead_provider_kind" AS ENUM('BUSINESS_SEARCH', 'PUBLIC_OPPORTUNITY', 'WEBSITE_RESEARCH', 'REFERRAL', 'INTERNAL_INBOUND');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('DISCOVERED', 'RESEARCHING', 'QUALIFIED', 'OUTREACH_DRAFTED', 'CONTACTED', 'RESPONSE', 'QUALIFIED_OPPORTUNITY', 'QUOTE_REQUEST', 'QUOTE_SENT', 'NEGOTIATION', 'WON', 'LOST', 'FOLLOW_UP');--> statement-breakpoint
CREATE TYPE "public"."processing_legal_basis" AS ENUM('GDPR_ART6_1A_CONSENT', 'GDPR_ART6_1B_CONTRACT', 'GDPR_ART6_1F_LEGITIMATE_INTEREST');--> statement-breakpoint
CREATE TYPE "public"."suppression_channel" AS ENUM('EMAIL', 'PHONE');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."consent_legal_basis" AS ENUM('GDPR_ART6_1A', 'TDDDG_25_1');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('MARKETING_EMAIL', 'MARKETING_PHONE', 'COOKIES_ANALYTICS', 'REVIEW_REQUEST', 'REFERRAL_CONTACT', 'OTHER_COMMUNICATION');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('GRANTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."consent_subject_type" AS ENUM('CUSTOMER', 'LEAD_CONTACT', 'USER');--> statement-breakpoint
CREATE TYPE "public"."setting_scope_type" AS ENUM('GLOBAL', 'SERVICE_AREA', 'CUSTOMER');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_lockout" (
	"email_normalized" text PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"token_hash" text NOT NULL,
	"role_key" text NOT NULL,
	"customer_id" uuid,
	"partner_id" uuid,
	"is_scope_admin" boolean DEFAULT false NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_scope_chk" CHECK ((
  ("invitation"."role_key" = 'CUSTOMER' AND "invitation"."customer_id" IS NOT NULL AND "invitation"."partner_id" IS NULL) OR
  ("invitation"."role_key" = 'PARTNER' AND "invitation"."partner_id" IS NOT NULL AND "invitation"."customer_id" IS NULL) OR
  ("invitation"."role_key" NOT IN ('CUSTOMER', 'PARTNER') AND "invitation"."customer_id" IS NULL AND "invitation"."partner_id" IS NULL)
)),
	CONSTRAINT "invitation_accepted_chk" CHECK (("invitation"."accepted_at" IS NULL) = ("invitation"."accepted_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"role_key" text NOT NULL,
	"permission_key" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "role_permission_role_key_permission_key_pk" PRIMARY KEY("role_key","permission_key"),
	CONSTRAINT "role_permission_scope_chk" CHECK ("role_permission"."scope" IN ('GLOBAL', 'OWN'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role_key" text NOT NULL,
	"customer_id" uuid,
	"partner_id" uuid,
	"is_scope_admin" boolean DEFAULT false NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_assignment_uq" UNIQUE NULLS NOT DISTINCT("user_id","role_key","customer_id","partner_id"),
	CONSTRAINT "user_role_scope_chk" CHECK ((
  ("user_role"."role_key" = 'CUSTOMER' AND "user_role"."customer_id" IS NOT NULL AND "user_role"."partner_id" IS NULL) OR
  ("user_role"."role_key" = 'PARTNER' AND "user_role"."partner_id" IS NOT NULL AND "user_role"."customer_id" IS NULL) OR
  ("user_role"."role_key" NOT IN ('CUSTOMER', 'PARTNER') AND "user_role"."customer_id" IS NULL AND "user_role"."partner_id" IS NULL)
)),
	CONSTRAINT "user_role_scope_admin_chk" CHECK ("user_role"."is_scope_admin" = false OR "user_role"."role_key" IN ('CUSTOMER', 'PARTNER'))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "city" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"state_code" text NOT NULL,
	"country" char(2) DEFAULT 'DE' NOT NULL,
	"official_key" text,
	"centroid" "geo_point",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_official_key_unique" UNIQUE("official_key")
);
--> statement-breakpoint
CREATE TABLE "postal_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"country" char(2) DEFAULT 'DE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postal_code_code_country_uq" UNIQUE("code","country")
);
--> statement-breakpoint
CREATE TABLE "postal_code_city" (
	"postal_code_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	CONSTRAINT "postal_code_city_postal_code_id_city_id_pk" PRIMARY KEY("postal_code_id","city_id")
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" "service_unit" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "service_area" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "service_area_kind" NOT NULL,
	"center" "geo_point",
	"radius_m" integer,
	"boundary" "geo_multipolygon",
	"active" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_area_key_unique" UNIQUE("key"),
	CONSTRAINT "service_area_shape_chk" CHECK ((
        ("service_area"."kind" = 'CIRCLE' AND "service_area"."center" IS NOT NULL AND "service_area"."radius_m" IS NOT NULL AND "service_area"."boundary" IS NULL) OR
        ("service_area"."kind" = 'POLYGON' AND "service_area"."boundary" IS NOT NULL AND "service_area"."center" IS NULL AND "service_area"."radius_m" IS NULL)
      )),
	CONSTRAINT "service_area_radius_chk" CHECK ("service_area"."radius_m" IS NULL OR ("service_area"."radius_m" > 0 AND "service_area"."radius_m" <= 1000000))
);
--> statement-breakpoint
CREATE TABLE "service_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_category_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "customer_kind" NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"status" "customer_status" DEFAULT 'ACTIVE' NOT NULL,
	"duplicate_review_status" "duplicate_review_status" DEFAULT 'NONE' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "customer_company_name_chk" CHECK ("customer"."kind" = 'PRIVATE' OR "customer"."company_name" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "customer_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_type" "address_type" NOT NULL,
	"street" text NOT NULL,
	"house_number" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"country" char(2) DEFAULT 'DE' NOT NULL,
	"city_id" uuid,
	"postal_code_id" uuid,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"location" "geo_point" GENERATED ALWAYS AS (CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography END) STORED,
	"geocoding_status" "geocoding_status" DEFAULT 'PENDING' NOT NULL,
	"geocoded_at" timestamp with time zone,
	"source" "address_source" NOT NULL,
	"verification_status" "address_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "customer_address_coordinates_chk" CHECK (("customer_address"."latitude" IS NULL) = ("customer_address"."longitude" IS NULL)),
	CONSTRAINT "customer_address_coordinate_range_chk" CHECK ("customer_address"."latitude" IS NULL OR ("customer_address"."latitude" BETWEEN -90 AND 90 AND "customer_address"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "customer_address_geocoding_chk" CHECK (("customer_address"."geocoding_status" IN ('SUCCEEDED', 'MANUAL')) = ("customer_address"."latitude" IS NOT NULL AND "customer_address"."geocoded_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customer_duplicate_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"candidate_customer_id" uuid NOT NULL,
	"matched_by" "customer_identity_kind" NOT NULL,
	"status" "duplicate_candidate_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	CONSTRAINT "customer_duplicate_candidate_uq" UNIQUE("customer_id","candidate_customer_id","matched_by"),
	CONSTRAINT "customer_duplicate_candidate_self_chk" CHECK ("customer_duplicate_candidate"."customer_id" <> "customer_duplicate_candidate"."candidate_customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "customer_identity_kind" NOT NULL,
	"value_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_identity_customer_kind_value_uq" UNIQUE("customer_id","kind","value_hash")
);
--> statement-breakpoint
CREATE TABLE "partner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"status" "partner_status" DEFAULT 'PENDING_VERIFICATION' NOT NULL,
	"base_latitude" numeric(9, 6) NOT NULL,
	"base_longitude" numeric(9, 6) NOT NULL,
	"base_location" "geo_point" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(base_longitude::double precision, base_latitude::double precision), 4326)::geography) STORED NOT NULL,
	"service_radius_m" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "partner_service_radius_chk" CHECK ("partner"."service_radius_m" > 0 AND "partner"."service_radius_m" <= 300000)
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"name" text NOT NULL,
	"property_type" "property_type" NOT NULL,
	"area_sqm" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "property_area_chk" CHECK ("property"."area_sqm" IS NULL OR "property"."area_sqm" > 0)
);
--> statement-breakpoint
CREATE TABLE "contact_suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "suppression_channel" NOT NULL,
	"value_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_reference" text,
	"status" "lead_status" DEFAULT 'DISCOVERED' NOT NULL,
	"company_name" text NOT NULL,
	"segment" text,
	"website" text,
	"postal_code" text,
	"city" text,
	"location" "geo_point",
	"outside_service_area" boolean,
	"score" integer,
	"owner_user_id" text,
	"collected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "lead_score_chk" CHECK ("lead"."score" IS NULL OR "lead"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "lead_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"role_title" text,
	"email" text,
	"phone" text,
	"source_id" uuid NOT NULL,
	"legal_basis" "processing_legal_basis" NOT NULL,
	"consent_status" "contact_consent_status" DEFAULT 'UNKNOWN' NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"suppressed_at" timestamp with time zone,
	"suppression_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_contact_channel_chk" CHECK ("lead_contact"."email" IS NOT NULL OR "lead_contact"."phone" IS NOT NULL),
	CONSTRAINT "lead_contact_suppression_chk" CHECK ("lead_contact"."suppressed" = ("lead_contact"."suppressed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lead_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"provider_kind" "lead_provider_kind" NOT NULL,
	"legal_basis" "processing_legal_basis" NOT NULL,
	"terms_reviewed_at" timestamp with time zone,
	"allowed_use" text,
	"retention_days" integer NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_source_key_unique" UNIQUE("key"),
	CONSTRAINT "lead_source_enabled_requires_review_chk" CHECK ("lead_source"."enabled" = false OR (
        "lead_source"."allowed_use" IS NOT NULL AND length(trim("lead_source"."allowed_use")) > 0 AND (
          "lead_source"."provider_kind" IN ('REFERRAL', 'INTERNAL_INBOUND') OR "lead_source"."terms_reviewed_at" IS NOT NULL
        )
      )),
	CONSTRAINT "lead_source_retention_chk" CHECK ("lead_source"."retention_days" BETWEEN 1 AND 1095),
	CONSTRAINT "lead_source_rate_limit_chk" CHECK ("lead_source"."rate_limit_per_minute" BETWEEN 1 AND 600)
);
--> statement-breakpoint
CREATE TABLE "lead_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_status" "lead_status" NOT NULL,
	"to_status" "lead_status" NOT NULL,
	"actor_user_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_status_transition_change_chk" CHECK ("lead_status_transition"."from_status" <> "lead_status_transition"."to_status")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text,
	CONSTRAINT "audit_log_actor_chk" CHECK (("audit_log"."actor_type" = 'SYSTEM') OR ("audit_log"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "consent_subject_type" NOT NULL,
	"subject_id" text NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"legal_basis" "consent_legal_basis" NOT NULL,
	"status" "consent_status" NOT NULL,
	"granted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"source" text NOT NULL,
	"text_version" text NOT NULL,
	"evidence_reference" text,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_status_dates_chk" CHECK (("consent"."status" = 'GRANTED' AND "consent"."granted_at" IS NOT NULL AND "consent"."withdrawn_at" IS NULL) OR
          ("consent"."status" = 'WITHDRAWN' AND "consent"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "consent_cookie_basis_chk" CHECK (("consent"."purpose" = 'COOKIES_ANALYTICS') = ("consent"."legal_basis" = 'TDDDG_25_1'))
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"scope_type" "setting_scope_type" NOT NULL,
	"scope_id" uuid,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"change_reason" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "setting_version_uq" UNIQUE NULLS NOT DISTINCT("key","scope_type","scope_id","version"),
	CONSTRAINT "setting_scope_chk" CHECK (("setting"."scope_type" = 'GLOBAL') = ("setting"."scope_id" IS NULL)),
	CONSTRAINT "setting_version_chk" CHECK ("setting"."version" >= 1),
	CONSTRAINT "setting_period_chk" CHECK ("setting"."effective_until" IS NULL OR "setting"."effective_until" > "setting"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_key_role_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."role"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_key_role_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."role"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_key_role_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."role"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postal_code_city" ADD CONSTRAINT "postal_code_city_postal_code_id_postal_code_id_fk" FOREIGN KEY ("postal_code_id") REFERENCES "public"."postal_code"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postal_code_city" ADD CONSTRAINT "postal_code_city_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_category_id_service_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_postal_code_id_postal_code_id_fk" FOREIGN KEY ("postal_code_id") REFERENCES "public"."postal_code"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_duplicate_candidate" ADD CONSTRAINT "customer_duplicate_candidate_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_duplicate_candidate" ADD CONSTRAINT "customer_duplicate_candidate_candidate_customer_id_customer_id_fk" FOREIGN KEY ("candidate_customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identity" ADD CONSTRAINT "customer_identity_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_address_id_customer_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_address"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_source_id_lead_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lead_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contact" ADD CONSTRAINT "lead_contact_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contact" ADD CONSTRAINT "lead_contact_source_id_lead_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lead_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_status_transition" ADD CONSTRAINT "lead_status_transition_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_role_user_id_idx" ON "user_role" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "city_name_idx" ON "city" USING btree ("name");--> statement-breakpoint
CREATE INDEX "postal_code_city_city_idx" ON "postal_code_city" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "service_category_idx" ON "service" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "service_area_center_gix" ON "service_area" USING gist ("center");--> statement-breakpoint
CREATE INDEX "service_area_boundary_gix" ON "service_area" USING gist ("boundary");--> statement-breakpoint
CREATE INDEX "customer_address_customer_idx" ON "customer_address" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_address_location_gix" ON "customer_address" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_identity_unique_kinds_uq" ON "customer_identity" USING btree ("kind","value_hash") WHERE "customer_identity"."kind" IN ('EMAIL', 'TAX_ID', 'PAYMENT_REFERENCE');--> statement-breakpoint
CREATE INDEX "customer_identity_lookup_idx" ON "customer_identity" USING btree ("kind","value_hash");--> statement-breakpoint
CREATE INDEX "partner_base_location_gix" ON "partner" USING gist ("base_location");--> statement-breakpoint
CREATE INDEX "property_customer_idx" ON "property" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_suppression_uq" ON "contact_suppression" USING btree ("channel","value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_source_reference_uq" ON "lead" USING btree ("source_id","source_reference") WHERE "lead"."source_reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lead_status_idx" ON "lead" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lead_location_gix" ON "lead" USING gist ("location");--> statement-breakpoint
CREATE INDEX "lead_contact_lead_idx" ON "lead_contact" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_status_transition_lead_idx" ON "lead_status_transition" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_subject_idx" ON "consent" USING btree ("subject_type","subject_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "setting_lookup_idx" ON "setting" USING btree ("key","scope_type","scope_id");