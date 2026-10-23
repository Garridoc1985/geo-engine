import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agendaForDate,
  applyAdminAction,
  bookingDetail,
  createBlock,
  deleteBlock,
  holidayWarning,
  listUpcomingBlocks,
} from "../../src/server/admin/agenda.ts";
import { handleAvailability } from "../../src/server/api/handlers.ts";
import { cancelBooking } from "../../src/server/booking/cancel-booking.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookingBlocks, bookings, whatsappMessages } from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const DATE = "2026-09-17";

async function newBooking(
  db: AppDb,
  start: string,
  phone: string,
  mode: "taller" | "retiro" = "taller",
  whatsappConsent = mode === "retiro",
) {
  const result = await createBooking(
    db,
    {
      mode,
      serviceDate: DATE,
      start,
      customerName: "Camila Soto",
      phoneE164: phone,
      email: "camila@ejemplo.cl",
      bike: "Gravel Canyon",
      description: "Mantención general",
      comuna: mode === "retiro" ? "Vitacura" : null,
      address: mode === "retiro" ? "Av. Bicentenario 123" : null,
      ipHash: null,
      whatsappConsent,
    },
    NOW,
  );
  if (!result.ok) {
    throw new Error(`no se pudo crear la reserva: ${result.code}`);
  }
  return result.booking;
}

async function dayStatus(db: AppDb, date: string): Promise<string> {
  const url = new URL(`https://vectorbikes.cl/api/disponibilidad?desde=${date}&dias=1`);
  const response = await handleAvailability(url, { db, now: NOW, ip: null });
  const body = (await response.json()) as { days: { status: string }[] };
  return body.days[0]?.status ?? "sin-dato";
}

async function withWhatsAppDisabled<T>(run: () => Promise<T>): Promise<T> {
  const previousEnabled = process.env.WHATSAPP_ENABLED;
  process.env.WHATSAPP_ENABLED = "false";
  try {
    return await run();
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.WHATSAPP_ENABLED;
    } else {
      process.env.WHATSAPP_ENABLED = previousEnabled;
    }
  }
}

describe("panel admin", () => {
  let test: TestDb;

  beforeEach(async () => {
    test = await createTestDb();
    return () => test.close();
  });

  it("lista todas las reservas del día por hora, con sus estados", async () => {
    const late = await newBooking(test.db, "18:00", "+56911111111");
    const early = await newBooking(test.db, "15:00", "+56922222222");
    const middle = await newBooking(test.db, "16:00", "+56933333333");
    await cancelBooking(test.db, { bookingId: middle.id, by: "customer", now: NOW });

    const agenda = await agendaForDate(test.db, DATE);

    expect(agenda.map((row) => row.id)).toEqual([early.id, middle.id, late.id]);
    expect(agenda.map((row) => row.status)).toEqual(["confirmed", "cancelled", "confirmed"]);
    expect(await bookingDetail(test.db, early.id)).not.toBeNull();
    expect(await bookingDetail(test.db, "no-es-uuid")).toBeNull();
  });

  it("cancela como admin y libera los bloques", async () => {
    const booking = await newBooking(test.db, "15:00", "+56911111111");

    const result = await applyAdminAction(test.db, booking.id, "cancelar", NOW);

    expect(result.ok).toBe(true);
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledBy).toBe("admin");
    const blocks = await test.db
      .select()
      .from(bookingBlocks)
      .where(eq(bookingBlocks.bookingId, booking.id));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => !block.isActive)).toBe(true);
  });

  it("completa solo desde confirmed y no toca una cancelada", async () => {
    const confirmed = await newBooking(test.db, "15:00", "+56911111111");
    const cancelled = await newBooking(test.db, "16:00", "+56922222222");
    await applyAdminAction(test.db, cancelled.id, "cancelar", NOW);
    const [before] = await test.db.select().from(bookings).where(eq(bookings.id, cancelled.id));

    const done = await applyAdminAction(test.db, confirmed.id, "completar", NOW);
    const refused = await applyAdminAction(test.db, cancelled.id, "completar", NOW);

    expect(done.ok && done.booking.status).toBe("completed");
    expect(done.ok && done.booking.completedAt).not.toBeNull();
    expect(refused).toEqual({ ok: false, code: "invalid_transition" });
    const [after] = await test.db.select().from(bookings).where(eq(bookings.id, cancelled.id));
    expect(after).toEqual(before);
  });

  it("marca reservas de ambas modalidades listas y permite completarlas desde ese estado", async () => {
    const pickup = await newBooking(test.db, "15:00", "+56911111111", "retiro");
    const workshop = await newBooking(test.db, "16:00", "+56922222222", "taller");

    await withWhatsAppDisabled(async () => {
      const ready = await applyAdminAction(test.db, pickup.id, "lista_para_retirar", NOW);
      const workshopReady = await applyAdminAction(test.db, workshop.id, "lista_para_retirar", NOW);
      const noShowFromReady = await applyAdminAction(test.db, workshop.id, "no_show", NOW);
      const completed = await applyAdminAction(test.db, pickup.id, "completar", NOW);

      expect(ready.ok && ready.booking.status).toBe("ready_for_pickup");
      expect(workshopReady.ok && workshopReady.booking.status).toBe("ready_for_pickup");
      expect(noShowFromReady).toEqual({ ok: false, code: "invalid_transition" });
      expect(completed.ok && completed.booking.status).toBe("completed");
      expect(await applyAdminAction(test.db, pickup.id, "lista_para_retirar", NOW)).toEqual({
        ok: false,
        code: "invalid_transition",
      });
    });
  });

  it("no permite reintentar aviso listo sin consentimiento ni con envío en curso o incierto", async () => {
    const withoutConsent = await newBooking(test.db, "15:00", "+56911111111", "taller");
    const withConsent = await newBooking(test.db, "16:00", "+56922222222", "taller", true);
    await withWhatsAppDisabled(async () => {
      await applyAdminAction(test.db, withoutConsent.id, "lista_para_retirar", NOW);
      expect(
        await applyAdminAction(test.db, withoutConsent.id, "reintentar_whatsapp", NOW),
      ).toEqual({ ok: false, code: "invalid_transition" });
      await applyAdminAction(test.db, withConsent.id, "lista_para_retirar", NOW);
      for (const status of ["pending", "sent", "sending", "unknown"] as const) {
        await test.db
          .insert(whatsappMessages)
          .values({
            bookingId: withConsent.id,
            type: "ready",
            status,
            attempts: 1,
          })
          .onConflictDoUpdate({
            target: [whatsappMessages.bookingId, whatsappMessages.type],
            set: { status },
          });
        expect(await applyAdminAction(test.db, withConsent.id, "reintentar_whatsapp", NOW)).toEqual(
          { ok: false, code: "invalid_transition" },
        );
      }
    });
  });

  it("un recordatorio enviado no bloquea el reintento de aviso de bicicleta lista", async () => {
    const booking = await newBooking(test.db, "15:00", "+56911111111", "retiro");
    await withWhatsAppDisabled(async () => {
      await applyAdminAction(test.db, booking.id, "lista_para_retirar", NOW);
      await test.db.insert(whatsappMessages).values({
        bookingId: booking.id,
        type: "reminder",
        status: "sent",
        attempts: 1,
        metaMessageId: "wamid.reminder",
        sentAt: NOW,
      });

      const retried = await applyAdminAction(test.db, booking.id, "reintentar_whatsapp", NOW);

      expect(retried.ok).toBe(true);
    });
  });

  it("permite reintentar solo un recordatorio fallido de reserva consentida y futura", async () => {
    const booking = await newBooking(test.db, "15:00", "+56911111111", "taller", true);
    await test.db.insert(whatsappMessages).values({
      bookingId: booking.id,
      type: "reminder",
      status: "failed",
      attempts: 1,
    });
    await withWhatsAppDisabled(async () => {
      const retried = await applyAdminAction(
        test.db,
        booking.id,
        "reintentar_recordatorio_whatsapp",
        NOW,
      );
      expect(retried.ok).toBe(true);

      await test.db
        .update(whatsappMessages)
        .set({ status: "unknown" })
        .where(eq(whatsappMessages.bookingId, booking.id));
      expect(
        await applyAdminAction(test.db, booking.id, "reintentar_recordatorio_whatsapp", NOW),
      ).toEqual({ ok: false, code: "invalid_transition" });
    });
  });

  it("marca no-show desde confirmed", async () => {
    const booking = await newBooking(test.db, "15:00", "+56911111111");

    const result = await applyAdminAction(test.db, booking.id, "no_show", NOW);

    expect(result.ok && result.booking.status).toBe("no_show");
    expect(await applyAdminAction(test.db, crypto.randomUUID(), "no_show", NOW)).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("un bloqueo de día completo cierra la disponibilidad hasta eliminarlo", async () => {
    expect(await dayStatus(test.db, "2026-09-22")).toBe("open");

    const created = await createBlock(test.db, {
      serviceDate: "2026-09-22",
      startTime: null,
      endTime: null,
      reason: "Vacaciones",
    });

    expect(created).toEqual({ ok: true });
    expect(await dayStatus(test.db, "2026-09-22")).toBe("blocked");
    const [block] = await listUpcomingBlocks(test.db, "2026-09-15");
    expect(block?.reason).toBe("Vacaciones");
    expect(await deleteBlock(test.db, block?.id ?? "")).toBe(true);
    expect(await dayStatus(test.db, "2026-09-22")).toBe("open");
  });

  it("rechaza un bloqueo con término antes del inicio o con una sola hora", async () => {
    const inverted = await createBlock(test.db, {
      serviceDate: "2026-09-22",
      startTime: "17:00",
      endTime: "16:00",
      reason: "Trámite",
    });
    const partial = await createBlock(test.db, {
      serviceDate: "2026-09-22",
      startTime: "17:00",
      endTime: null,
      reason: "Trámite",
    });

    expect(inverted.ok).toBe(false);
    expect(!inverted.ok && inverted.errors.endTime).toBe(
      "La hora de término debe ser posterior a la de inicio.",
    );
    expect(!partial.ok && partial.errors.endTime).toBe(
      "Indica desde y hasta, o deja ambas vacías para bloquear el día.",
    );
    expect(await listUpcomingBlocks(test.db, "2026-09-15")).toHaveLength(0);
  });
});

describe("advertencia de feriados", () => {
  it("avisa cuando el horizonte llega a un año sin feriados", () => {
    expect(holidayWarning(new Date("2027-12-10T15:00:00.000Z"))).toContain("2028");
    expect(holidayWarning(new Date("2026-12-10T15:00:00.000Z"))).toBeNull();
    expect(holidayWarning(new Date("2026-09-16T15:00:00.000Z"))).toBeNull();
  });
});
