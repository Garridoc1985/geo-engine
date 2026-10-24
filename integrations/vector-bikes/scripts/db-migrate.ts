import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getDbEnv } from "../src/lib/env.ts";

if (process.env.REPLIT_DEPLOYMENT) {
  console.error(
    "db:migrate no corre dentro de una deployment: Replit propaga el esquema al publicar.",
  );
  process.exit(2);
}

try {
  const { DATABASE_URL } = getDbEnv();
  const client = postgres(DATABASE_URL, { max: 1 });
  await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
  await client.end();
  console.log(JSON.stringify({ ok: true, migrationsFolder: "drizzle" }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
