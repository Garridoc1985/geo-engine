import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cancelBooking } from "../../src/server/booking/cancel-booking.ts";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookingBlocks, bookings } from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");

function input(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    mode: "taller",
    serviceDate: "2026-09-16",
    start: "16:30",
    customerName: "Javiera Rojas",
    phoneE164: "+56911111111",
    email: "javiera@ejemplo.cl",
    bike: "Ruta Specialized",
    description: "Cambio de cadena y ajuste de frenos",
    comuna: null,
    address: null,
    ipHash: null,
    ...overrides,
  };
}

async function activeStarts(db: AppDb, serviceDate: string): Promise<string[]> {
  const rows = await db
    .select({ blockStart: bookingBlocks.blockStart })
    .from(bookingBlocks)
    .where(and(eq(bookingBlocks.serviceDate, serviceDate), eq(bookingBlocks.isActive, true)))
    .orderBy(bookingBlocks.blockStart);
  return rows.map((row) => row.blockStart);
}

describe("createBooking", () => {
  let test: TestDb;
  let db: AppDb;

  beforeEach(async () => {
    test = await createTestDb();
    db = test.db;
    return () => test.close();
  });

  it("inserta una reserva sin correo y rechaza otro intento al mismo bloque", async () => {
    const first = await createBooking(db, input({ email: null }), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.code);
    }
    expect(first.booking.email).toBeNull();
    const [stored] = await db.select().from(bookings).where(eq(bookings.id, first.booking.id));
    expect(stored?.email).toBeNull();

    const second = await createBooking(db, input({ email: null, phoneE164: "+56922222222" }), NOW);
    expect(second).toEqual({ ok: false, code: "slot_unavailable" });
    expect(await activeStarts(db, "2026-09-16")).toEqual(["16:30:00"]);
  });

  it("mantiene el máximo de cuatro reservas diarias cuando no tienen correo", async () => {
    const starts = ["15:00", "15:30", "16:00", "16:30"];
    for (const [index, start] of starts.entries()) {
      const created = await createBooking(
        db,
        input({ email: null, start, phoneE164: `+5693000000${index}` }),
        NOW,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error(created.code);
      }
      expect(created.booking.email).toBeNull();
    }
    const fifth = await createBooking(
      db,
      input({ email: null, start: "17:00", phoneE164: "+56930000009" }),
      NOW,
    );
    expect(fifth).toEqual({ ok: false, code: "slot_unavailable" });
    expect(await activeStarts(db, "2026-09-16")).toEqual(starts.map((start) => `${start}:00`));
    expect(await db.select().from(bookings)).toHaveLength(4);
  });

  it("crea una reserva de taller con código y un bloque", async () => {
    const result = await createBooking(db, input(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.code);
    }
    expect(result.booking.code).toBe("VB-260916-1630");
    expect(result.booking.startsAt.toISOString()).toBe("2026-09-16T19:30:00.000Z");
    expect(result.booking.pickupFeeClp).toBe(0);
    expect(result.booking.whatsappConsentAt).toBeNull();
    expect(await activeStarts(db, "2026-09-16")).toEqual(["16:30:00"]);
  });

  it("registra el instante solo si la persona autorizó contacto operativo por WhatsApp", async () => {
    const result = await createBooking(db, input({ whatsappConsent: true }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.code);
    }
    expect(result.booking.whatsappConsentAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("crea una reserva de retiro con dos bloques y la tarifa", async () => {
    const result = await createBooking(
      db,
      input({ mode: "retiro", start: "16:00", comuna: "Vitacura", address: "Av. Kennedy 7666" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.code);
    }
    expect(result.booking.pickupFeeClp).toBe(15000);
    expect(await activeStarts(db, "2026-09-16")).toEqual(["16:00:00", "16:30:00"]);
  });

  it("rechaza un segundo intento al mismo bloque", async () => {
    await createBooking(db, input(), NOW);
    const second = await createBooking(db, input({ phoneE164: "+56922222222" }), NOW);
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("esperaba slot_unavailable");
    }
    expect(second.code).toBe("slot_unavailable");
    expect(await activeStarts(db, "2026-09-16")).toEqual(["16:30:00"]);
  });

  it("rechaza retiro en el último bloque del día", async () => {
    const result = await createBooking(
      db,
      input({ mode: "retiro", start: "19:30", comuna: "Las Condes", address: "Apoquindo 1" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("esperaba slot_unavailable");
    }
    expect(result.code).toBe("slot_unavailable");
  });

  it("rechaza la quinta reserva del día", async () => {
    const starts = ["15:00", "15:30", "16:00", "16:30"];
    for (const [index, start] of starts.entries()) {
      const created = await createBooking(
        db,
        input({ serviceDate: "2026-09-17", start, phoneE164: `+5693000000${index}` }),
        NOW,
      );
      expect(created.ok).toBe(true);
    }
    const fifth = await createBooking(
      db,
      input({ serviceDate: "2026-09-17", start: "17:00", phoneE164: "+56930000009" }),
      NOW,
    );
    expect(fifth.ok).toBe(false);
    if (fifth.ok) {
      throw new Error("esperaba slot_unavailable");
    }
    expect(fifth.code).toBe("slot_unavailable");
  });

  it("permite una sola reserva futura por teléfono", async () => {
    await createBooking(db, input(), NOW);
    const second = await createBooking(db, input({ serviceDate: "2026-09-17" }), NOW);
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("esperaba phone_limit");
    }
    expect(second.code).toBe("phone_limit");
  });

  it("cuenta una reserva lista para retiro como futura activa para el límite telefónico", async () => {
    const ready = await createBooking(db, input(), NOW);
    if (!ready.ok) {
      throw new Error(ready.code);
    }
    await db
      .update(bookings)
      .set({ status: "ready_for_pickup" })
      .where(eq(bookings.id, ready.booking.id));

    const second = await createBooking(db, input({ serviceDate: "2026-09-17" }), NOW);

    expect(second).toEqual({ ok: false, code: "phone_limit" });
  });

  it("rechaza un feriado", async () => {
    const result = await createBooking(db, input({ serviceDate: "2026-09-18" }), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("esperaba slot_unavailable");
    }
    expect(result.code).toBe("slot_unavailable");
  });

  it("libera el bloque al cancelar y numera la reserva siguiente", async () => {
    const first = await createBooking(db, input(), NOW);
    if (!first.ok) {
      throw new Error(first.code);
    }

    const cancelled = await cancelBooking(db, {
      bookingId: first.booking.id,
      by: "customer",
      now: NOW,
    });
    expect(cancelled.ok).toBe(true);
    expect(await activeStarts(db, "2026-09-16")).toEqual([]);

    const again = await createBooking(db, input({ phoneE164: "+56944444444" }), NOW);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      throw new Error(again.code);
    }
    expect(again.booking.code).toBe("VB-260916-1630-2");
    expect(await activeStarts(db, "2026-09-16")).toEqual(["16:30:00"]);
  });

  it("no deja que el cliente cancele una reserva ya empezada, el taller sí", async () => {
    const created = await createBooking(db, input(), NOW);
    if (!created.ok) {
      throw new Error(created.code);
    }
    const started = new Date("2026-09-16T19:31:00.000Z");

    const byCustomer = await cancelBooking(db, {
      bookingId: created.booking.id,
      by: "customer",
      now: started,
    });
    expect(byCustomer.ok).toBe(false);
    if (byCustomer.ok) {
      throw new Error("esperaba started");
    }
    expect(byCustomer.code).toBe("started");

    const byAdmin = await cancelBooking(db, {
      bookingId: created.booking.id,
      by: "admin",
      now: started,
    });
    expect(byAdmin.ok).toBe(true);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(bookingBlocks)
      .where(
        and(eq(bookingBlocks.bookingId, created.booking.id), eq(bookingBlocks.isActive, true)),
      );
    expect(Number(row?.n ?? -1)).toBe(0);
  });
});
