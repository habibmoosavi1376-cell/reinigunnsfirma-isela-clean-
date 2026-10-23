/** Returns TEST_DATABASE_URL and refuses anything that does not look like a test database. */
export function requireTestDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("TEST_DATABASE_URL is required for integration tests.");
  }
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(databaseName)) {
    throw new Error(`Refusing to use database "${databaseName}": name must contain "test".`);
  }
  return url;
}
