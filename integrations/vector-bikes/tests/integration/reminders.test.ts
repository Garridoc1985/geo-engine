import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cancelBooking } from "../../src/server/booking/cancel-booking.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookings } from "../../src/server/db/schema.ts";
import { sendReminders } from "../../src/server/email/reminders.ts";
import { type EmailTransport, consoleOutbox } from "../../src/server/email/transport.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 10:00 hora local. */
const NOW = new Date("2026-09-15T13:00:00.000Z");

async function newBooking(
  db: AppDb,
  mode: "taller" | "retiro",
  serviceDate: string,
  start: string,
  phone: string,
) {
  const isPickup = mode === "retiro";
  const result = await createBooking(
    db,
    {
      mode,
      serviceDate,
      start,
      customerName: "Diego Muñoz",
      phoneE164: phone,
      email: "diego@ejemplo.cl",
      bike: "MTB Scott",
      description: "Purga de frenos",
      comuna: isPickup ? "Las Condes" : null,
      address: isPickup ? "Av. Apoquindo 5000" : null,
      ipHash: null,
    },
    NOW,
  );
  if (!result.ok) {
    throw new Error(`no se pudo crear la reserva: ${result.code}`);
  }
  return result.booking;
}

async function reminderState(db: AppDb): Promise<Record<string, boolean>> {
  const rows = await db.select().from(bookings);
  return Object.fromEntries(rows.map((row) => [row.id, row.reminderSentAt !== null]));
}

describe("recordatorios", () => {
  let test: TestDb;

  beforeEach(async () => {
    consoleOutbox.length = 0;
    test = await createTestDb();
    return () => test.close();
  });

  it("omite reservas sin correo y envía a las que sí tienen correo el mismo día", async () => {
    const withoutEmail = await newBooking(test.db, "taller", "2026-09-16", "15:00", "+56911111111");
    await test.db.update(bookings).set({ email: null }).where(eq(bookings.id, withoutEmail.id));
    const withEmail = await newBooking(test.db, "taller", "2026-09-16", "15:30", "+56922222222");

    expect(await sendReminders(test.db, NOW)).toEqual({ sent: 1, failed: 0 });
    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(withEmail.email);
    expect(consoleOutbox[0]?.subject).toContain(withEmail.code);
    expect(await reminderState(test.db)).toEqual({
      [withoutEmail.id]: false,
      [withEmail.id]: true,
    });
    const [stored] = await test.db.select().from(bookings).where(eq(bookings.id, withoutEmail.id));
    expect(stored?.reminderSentAt).toBeNull();
    expect(await sendReminders(test.db, NOW)).toEqual({ sent: 0, failed: 0 });
    expect(consoleOutbox).toHaveLength(1);
  });

  it("envía una vez a las confirmadas de mañana y la segunda corrida no envía nada", async () => {
    const a = await newBooking(test.db, "taller", "2026-09-16", "15:00", "+56911111111");
    const b = await newBooking(test.db, "retiro", "2026-09-16", "17:00", "+56922222222");
    const c = await newBooking(test.db, "taller", "2026-09-16", "18:00", "+56933333333");
    const d = await newBooking(test.db, "taller", "2026-09-17", "15:00", "+56944444444");
    await cancelBooking(test.db, { bookingId: c.id, by: "customer", now: NOW });

    expect(await sendReminders(test.db, NOW)).toEqual({ sent: 2, failed: 0 });

    expect(consoleOutbox).toHaveLength(2);
    expect(consoleOutbox.every((message) => message.subject.startsWith("Recordatorio:"))).toBe(
      true,
    );
    expect(await reminderState(test.db)).toEqual({
      [a.id]: true,
      [b.id]: true,
      [c.id]: false,
      [d.id]: false,
    });

    expect(await sendReminders(test.db, NOW)).toEqual({ sent: 0, failed: 0 });
    expect(consoleOutbox).toHaveLength(2);
  });

  it("mantiene los recordatorios de correo para reservas listas para retiro", async () => {
    const booking = await newBooking(test.db, "taller", "2026-09-16", "15:00", "+56911111111");
    await test.db
      .update(bookings)
      .set({ status: "ready_for_pickup" })
      .where(eq(bookings.id, booking.id));

    expect(await sendReminders(test.db, NOW)).toEqual({ sent: 1, failed: 0 });
    expect(consoleOutbox).toHaveLength(1);
    expect((await reminderState(test.db))[booking.id]).toBe(true);
  });

  it("un envío fallido suma a failed y deja la reserva sin marcar", async () => {
    const booking = await newBooking(test.db, "taller", "2026-09-16", "15:00", "+56911111111");
    const broken: EmailTransport = {
      send: async () => {
        throw new Error("sin conexión");
      },
    };

    expect(await sendReminders(test.db, NOW, { transport: broken })).toEqual({
      sent: 0,
      failed: 1,
    });
    expect(await reminderState(test.db)).toEqual({ [booking.id]: false });
  });
});
