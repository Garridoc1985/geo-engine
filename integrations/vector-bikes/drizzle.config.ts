import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// Fase 1: el esquema se reparte en schema.ts, schema-taller.ts, schema-orders.ts y schema-reports.ts (< 400 líneas cada uno).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema*.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/vector_bikes",
  },
  strict: true,
  verbose: true,
});
