import { createDatabase } from "@isela/database";
import { syncRbacCatalog } from "../rbac-sync.ts";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set. Refusing to sync the RBAC catalogue.");
  process.exit(1);
}

const handle = createDatabase(url, { maxConnections: 1, applicationName: "isela-rbac-sync" });
try {
  await syncRbacCatalog(handle.db);
  console.log("RBAC catalogue synchronised.");
} finally {
  await handle.close();
}
