import { pgEnum } from "drizzle-orm/pg-core";

/*
 * Enums shared by several schema files. Kept in their own module so that catalog.ts and
 * crm.ts can both use them without an import cycle. Re-exported by crm.ts (public name).
 */

/**
 * Property types (day 4: HOUSE renamed to PRIVATE_HOME via RENAME VALUE; further types appended).
 * Shared by the public request form, the property register and the service catalogue.
 */
export const propertyType = pgEnum("property_type", [
  "APARTMENT",
  "PRIVATE_HOME",
  "OFFICE",
  "PRACTICE",
  "STAIRWELL",
  "COMMERCIAL",
  "OTHER",
  "RETAIL",
  "GASTRONOMY",
  "GYM",
  "HOLIDAY_RENTAL",
  "PROPERTY_MANAGEMENT",
]);
