import { createDatabase } from "../client.ts";
import { seedReferenceData } from "../seed/seed.ts";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set. Refusing to seed.");
  process.exit(1);
}

const handle = createDatabase(url, { maxConnections: 1, applicationName: "isela-seed" });
try {
  await seedReferenceData(handle.db);
  console.log("Reference data seeded.");
} finally {
  await handle.close();
}
