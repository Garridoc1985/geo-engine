import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import { bookingBlocks } from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const ATTEMPTS = 50;

function input(index: number): CreateBookingInput {
  return {
    mode: "taller",
    serviceDate: "2026-09-16",
    start: "16:30",
    customerName: `Cliente ${index}`,
    phoneE164: `+569${String(10000000 + index)}`,
    email: `cliente${index}@ejemplo.cl`,
    bike: "Urbana",
    description: "Mantención general",
    comuna: null,
    address: null,
    ipHash: null,
  };
}

describe("concurrencia", () => {
  let test: TestDb;

  beforeAll(async () => {
    test = await createTestDb();
  });

  afterAll(async () => {
    await test.close();
  });

  it("deja pasar una sola reserva entre 50 intentos al mismo bloque", async () => {
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, index) => createBooking(test.db, input(index), NOW)),
    );

    const created = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok && result.code === "slot_unavailable");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(ATTEMPTS - 1);

    const [row] = await test.db
      .select({ n: sql<number>`count(*)` })
      .from(bookingBlocks)
      .where(
        and(
          eq(bookingBlocks.isActive, true),
          eq(bookingBlocks.serviceDate, "2026-09-16"),
          eq(bookingBlocks.blockStart, "16:30:00"),
        ),
      );
    expect(Number(row?.n ?? -1)).toBe(1);
  });
});
