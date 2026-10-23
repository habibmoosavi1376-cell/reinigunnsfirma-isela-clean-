-- Integrity guards that cannot be expressed in the Drizzle schema.

-- 1) Append-only tables: audit trail, consent evidence and lead status history must never
--    be modified or deleted through the application.
CREATE OR REPLACE FUNCTION isela_prevent_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER consent_append_only
  BEFORE UPDATE OR DELETE ON "consent"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
CREATE TRIGGER lead_status_transition_append_only
  BEFORE UPDATE OR DELETE ON "lead_status_transition"
  FOR EACH ROW EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint
-- TRUNCATE bypasses row triggers; block it for the audit trail as well.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION isela_prevent_modification();
--> statement-breakpoint

-- 2) Versioned settings: validity periods of the same key and scope must not overlap.
ALTER TABLE "setting" ADD CONSTRAINT "setting_no_overlap_excl" EXCLUDE USING gist (
  "key" WITH =,
  "scope_type" WITH =,
  (COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  tstzrange("effective_from", "effective_until", '[)') WITH &&
);
--> statement-breakpoint

-- 3) A property must reference an address of the same customer.
CREATE OR REPLACE FUNCTION isela_property_address_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "customer_address" a
    WHERE a."id" = NEW."address_id" AND a."customer_id" = NEW."customer_id"
  ) THEN
    RAISE EXCEPTION 'property.address_id must belong to property.customer_id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER property_address_owner
  BEFORE INSERT OR UPDATE OF "customer_id", "address_id" ON "property"
  FOR EACH ROW EXECUTE FUNCTION isela_property_address_owner_check();
