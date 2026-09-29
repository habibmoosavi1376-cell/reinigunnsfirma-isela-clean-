-- Required PostgreSQL extensions (idempotent).
-- postgis:    geography types and spatial functions for service areas and distances.
-- btree_gist: equality operators in GiST indexes, used by the exclusion constraint that
--             prevents overlapping validity periods of versioned settings.
-- Creating extensions requires sufficient privileges. On managed databases the extensions
-- may be pre-created by the provider; IF NOT EXISTS makes this migration a no-op then.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- Geography domains (SRID 4326). Referenced by the schema as "geo_point"/"geo_multipolygon".
CREATE DOMAIN geo_point AS geography(Point, 4326);
--> statement-breakpoint
CREATE DOMAIN geo_multipolygon AS geography(MultiPolygon, 4326);
