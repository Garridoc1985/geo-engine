import { readdirSync, readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import postgres from "postgres";
import { getDbEnv } from "../src/lib/env.ts";
import { orderTables } from "../src/server/db/schema-orders.ts";
import { reportTables } from "../src/server/db/schema-reports.ts";
import { tallerTables } from "../src/server/db/schema-taller.ts";
import { allTables } from "../src/server/db/schema.ts";

const CREATE_TABLE = /CREATE TABLE(?: IF NOT EXISTS)? "(?:public"\.")?([a-z_]+)"/g;
const DROP_TABLE = /DROP TABLE(?: IF EXISTS)? "(?:public"\.")?([a-z_]+)"/g;

function tablesFromMigrations(folder: string): string[] {
  const names = new Set<string>();
  const files = readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(`${folder}/${file}`, "utf8");
    for (const match of sqlText.matchAll(CREATE_TABLE)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
    for (const match of sqlText.matchAll(DROP_TABLE)) {
      if (match[1]) {
        names.delete(match[1]);
      }
    }
  }
  return [...names].sort();
}

try {
  const expected = tablesFromMigrations("drizzle");
  if (expected.length === 0) {
    throw new Error("No hay CREATE TABLE en drizzle/*.sql: ejecuta pnpm db:generate");
  }
  const { DATABASE_URL } = getDbEnv();
  const sql = postgres(DATABASE_URL, { max: 1 });
  await sql`select 1`;
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'
  `;
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = 'public'
  `;
  const constraints = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition from pg_constraint
    where conname = 'bookings_status_check'
  `;
  await sql.end();
  const present = new Set(rows.map((row) => row.table_name));
  const missing = expected.filter((name) => !present.has(name));
  if (missing.length > 0) {
    console.error(JSON.stringify({ ok: false, missing }));
    process.exit(1);
  }
  const presentColumns = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = [...allTables, ...tallerTables, ...orderTables, ...reportTables]
    .flatMap((table) =>
      Object.values(getTableColumns(table)).map(
        (column) => `${getTableName(table)}.${column.name}`,
      ),
    )
    .filter((name) => !presentColumns.has(name));
  if (
    missingColumns.length > 0 ||
    !constraints.some((row) => row.definition.includes("ready_for_pickup"))
  ) {
    console.error(JSON.stringify({ ok: false, missingColumns, readyStatusConstraint: false }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, tables: expected }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
