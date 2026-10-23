import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDbEnv } from "../../lib/env.ts";

export type AppDb = PgDatabase<PgQueryResultHKT>;

let cached: AppDb | undefined;

export function getDb(): AppDb {
  if (!cached) {
    const { DATABASE_URL } = getDbEnv();
    const client = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    cached = drizzle({ client }) as unknown as AppDb;
  }
  return cached;
}

export async function pingDb(db: AppDb): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
