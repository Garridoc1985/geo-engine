import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { AppDb } from "../../src/server/db/client.ts";

export type TestDb = { db: AppDb; client: PGlite; close: () => Promise<void> };

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const pgliteDb = drizzle({ client });
  await migrate(pgliteDb, { migrationsFolder: "drizzle" });
  return { db: pgliteDb as unknown as AppDb, client, close: () => client.close() };
}
