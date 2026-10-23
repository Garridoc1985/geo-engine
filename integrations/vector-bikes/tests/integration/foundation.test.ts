import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { EnvError, getDbEnv, getEmailEnv } from "../../src/lib/env.ts";
import { isUniqueViolation } from "../../src/server/db/client.ts";
import { allTables, bookingBlocks, bookings } from "../../src/server/db/schema.ts";
import { createTestDb } from "../helpers/pglite.ts";

const SERVICE_DATE = "2026-10-05";
const BLOCK_START = "10:00:00";

function bookingRow(code: string) {
  return {
    code,
    serviceDate: SERVICE_DATE,
    mode: "taller",
    startsAt: new Date("2026-10-05T13:00:00.000Z"),
    endsAt: new Date("2026-10-05T14:00:00.000Z"),
    customerName: "Cliente de prueba",
    phoneE164: "+56912345678",
    email: "cliente@ejemplo.cl",
    bike: "Ruta",
    description: "Mantención general",
    consentAt: new Date("2026-10-01T12:00:00.000Z"),
    cancelTokenHash: `hash-${code}`,
  };
}

describe("entorno", () => {
  it("nombra DATABASE_URL cuando falta", () => {
    expect(() => getDbEnv({})).toThrow(EnvError);
    expect(() => getDbEnv({})).toThrow(/DATABASE_URL/);
  });

  it("exige RESEND_API_KEY cuando EMAIL_TRANSPORT=resend", () => {
    expect(() =>
      getEmailEnv({
        EMAIL_TRANSPORT: "resend",
        EMAIL_FROM: "a <a@b.cl>",
        EMAIL_REPLY_TO: "a@b.cl",
        SHOP_NOTIFY_EMAIL: "a@b.cl",
      }),
    ).toThrow(/RESEND_API_KEY/);
  });
});

describe("base de datos", () => {
  it("crea todas las tablas del esquema al migrar", async () => {
    const { client, close } = await createTestDb();
    try {
      const result = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      for (const table of allTables) {
        expect(present.has(getTableConfig(table).name)).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it("rechaza un segundo bloque activo en la misma fecha y hora", async () => {
    const { db, close } = await createTestDb();
    try {
      const inserted = await db
        .insert(bookings)
        .values([bookingRow("VB-0001"), bookingRow("VB-0002"), bookingRow("VB-0003")])
        .returning({ id: bookings.id });
      const [first, second, third] = inserted;
      expect(first && second && third).toBeTruthy();
      if (!first || !second || !third) {
        throw new Error("faltan reservas de prueba");
      }

      await db.insert(bookingBlocks).values({
        bookingId: first.id,
        serviceDate: SERVICE_DATE,
        blockStart: BLOCK_START,
        isActive: true,
      });

      let caught: unknown;
      try {
        await db.insert(bookingBlocks).values({
          bookingId: second.id,
          serviceDate: SERVICE_DATE,
          blockStart: BLOCK_START,
          isActive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(isUniqueViolation(caught)).toBe(true);

      await db.insert(bookingBlocks).values({
        bookingId: third.id,
        serviceDate: SERVICE_DATE,
        blockStart: BLOCK_START,
        isActive: false,
      });
    } finally {
      await close();
    }
  });
});
