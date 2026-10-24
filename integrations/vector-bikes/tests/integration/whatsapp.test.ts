import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAdminAction } from "../../src/server/admin/agenda.ts";
import { handleWhatsAppCron } from "../../src/server/whatsapp/cron.ts";
import {
  reconcileNotice,
  sendNotice,
  sendPendingReminders,
  sendTemplate,
} from "../../src/server/whatsapp/service.ts";
import { bookings, whatsappMessages } from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-09-15T20:00:00Z");
const SECRET = "correct-secret-longer-than-thirty-two-characters";

describe("WhatsApp transaccional", () => {
  let test: TestDb;
  beforeEach(async () => {
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-only");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123456789");
    vi.stubEnv("WHATSAPP_REMINDER_TEMPLATE", "recordatorio_reserva");
    vi.stubEnv("WHATSAPP_READY_TEMPLATE", "bicicleta_lista");
    test = await createTestDb();
  });
  afterEach(async () => {
    await test.close();
    vi.unstubAllEnvs();
  });

  async function booking(code: string, optedIn: boolean, mode = "taller") {
    const [row] = await test.db
      .insert(bookings)
      .values({
        code,
        mode,
        serviceDate: "2026-09-16",
        startsAt: new Date("2026-09-16T18:00:00Z"),
        endsAt: new Date("2026-09-16T18:30:00Z"),
        customerName: "Ana",
        phoneE164: "+56912345678",
        email: "ana@example.cl",
        bike: "Ruta",
        description: "Mantención",
        comuna: mode === "retiro" ? "Vitacura" : null,
        address: mode === "retiro" ? "Av. Kennedy 7666" : null,
        pickupFeeClp: mode === "retiro" ? 15000 : 0,
        consentAt: NOW,
        whatsappConsentAt: optedIn ? NOW : null,
        cancelTokenHash: `hash-${code}`,
      })
      .returning();
    if (!row) throw new Error("test booking missing");
    return row;
  }

  it("no envía a reservas anteriores sin opt-in, y no toca el recordatorio de correo", async () => {
    const old = await booking("OLD", false);
    const opted = await booking("NEW", true);
    const sent: string[] = [];
    const sender = async (row: typeof opted) => {
      sent.push(row.code);
      return `wamid.${row.code}`;
    };
    expect(await sendPendingReminders(test.db, NOW, sender)).toEqual({
      sent: 1,
      failed: 0,
      skipped: 1,
    });
    expect(await sendPendingReminders(test.db, NOW, sender)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 2,
    });
    expect(sent).toEqual(["NEW"]);
    const rows = await test.db.select().from(bookings);
    expect(rows.find((row) => row.id === old.id)?.reminderSentAt).toBeNull();
    expect(rows.find((row) => row.id === opted.id)?.reminderSentAt).toBeNull();
  });

  it("reclama de forma atómica y audita un único envío con dos ejecuciones simultáneas", async () => {
    const row = await booking("RACE", true);
    let calls = 0;
    const sender = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "wamid.once";
    };
    const results = await Promise.all([
      sendNotice(test.db, row, "reminder", NOW, sender),
      sendNotice(test.db, row, "reminder", NOW, sender),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(calls).toBe(1);
    const audit = await test.db.select().from(whatsappMessages);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      type: "reminder",
      status: "sent",
      attempts: 1,
      metaMessageId: "wamid.once",
    });
  });

  it("incluye reservas del mismo día y excluye las canceladas o fuera de 24 horas", async () => {
    const today = await booking("TODAY", true);
    const later = await booking("LATER", true);
    const cancelled = await booking("CANCELLED", true);
    await test.db
      .update(bookings)
      .set({
        serviceDate: "2026-09-15",
        startsAt: new Date(NOW.getTime() + 7200000),
        endsAt: new Date(NOW.getTime() + 9000000),
      })
      .where(eq(bookings.id, today.id));
    await test.db
      .update(bookings)
      .set({
        startsAt: new Date(NOW.getTime() + 25 * 3600000),
        endsAt: new Date(NOW.getTime() + 26 * 3600000),
      })
      .where(eq(bookings.id, later.id));
    await test.db
      .update(bookings)
      .set({ status: "cancelled" })
      .where(eq(bookings.id, cancelled.id));
    const codes: string[] = [];
    expect(
      await sendPendingReminders(test.db, NOW, async (row) => {
        codes.push(row.code);
        return "wamid.today";
      }),
    ).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(codes).toEqual(["TODAY"]);
  });

  it("conserva ready tras rechazo y permite reintentar exactamente una vez", async () => {
    const row = await booking("READY", true, "retiro");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const marked = await applyAdminAction(test.db, row.id, "lista_para_retirar", NOW);
    expect(marked.ok && marked.booking.status).toBe("ready_for_pickup");
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    const [ready] = await test.db.select().from(bookings).where(eq(bookings.id, row.id));
    if (!ready) throw new Error("missing ready booking");
    expect(
      await sendNotice(test.db, ready, "ready", NOW, async () => {
        throw new Error("Meta rechazó la plantilla (HTTP 400)");
      }),
    ).toMatchObject({ status: "failed" });
    expect(await sendNotice(test.db, ready, "ready", NOW, async () => "wamid.ready")).toEqual({
      status: "sent",
    });
    expect(await sendNotice(test.db, ready, "ready", NOW, async () => "duplicate")).toMatchObject({
      status: "skipped",
    });
    const [audit] = await test.db.select().from(whatsappMessages);
    expect(audit).toMatchObject({ status: "sent", attempts: 2, metaMessageId: "wamid.ready" });
    expect((await applyAdminAction(test.db, row.id, "completar", NOW)).ok).toBe(true);
  });

  it("no reintenta automáticamente una respuesta de resultado incierto", async () => {
    const row = await booking("UNCERTAIN", true);
    expect(
      (
        await sendNotice(test.db, row, "reminder", NOW, async () => {
          throw new Error("connection reset");
        })
      ).status,
    ).toBe("failed");
    expect((await sendNotice(test.db, row, "reminder", NOW, async () => "duplicate")).status).toBe(
      "skipped",
    );
    const [audit] = await test.db.select().from(whatsappMessages);
    expect(audit?.status).toBe("unknown");
  });

  it("exige POST y CRON_SECRET antes de consultar las reservas", async () => {
    const url = "https://example.com/api/internal/whatsapp-reminders";
    const call = (method: string, token?: string) =>
      handleWhatsAppCron(
        new Request(url, {
          method,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        test.db,
        NOW,
        SECRET,
      );
    expect((await call("GET", SECRET)).status).toBe(405);
    expect((await call("POST")).status).toBe(401);
    expect((await call("POST", "wrong")).status).toBe(401);
    const valid = await call("POST", SECRET);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(valid.headers.get("cache-control")).toBe("no-store");
  });

  it("resuelve un envío interrumpido sin duplicar un mensaje aceptado por Meta", async () => {
    const row = await booking("CRASH", true);
    await test.db.insert(whatsappMessages).values({
      bookingId: row.id,
      type: "reminder",
      status: "sending",
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - 180000),
    });
    expect(
      await reconcileNotice(
        test.db,
        row.id,
        "reminder",
        "sent",
        "Confirmado con evidencia de Meta",
        "wamid.accepted",
        NOW,
        true,
      ),
    ).toBe(true);
    expect((await sendNotice(test.db, row, "reminder", NOW, async () => "duplicate")).status).toBe(
      "skipped",
    );
    const [audit] = await test.db.select().from(whatsappMessages);
    expect(audit).toMatchObject({ status: "sent", metaMessageId: "wamid.accepted", attempts: 1 });
    expect(audit?.reconciliationNote).toContain("Confirmado");
  });

  it("solo desbloquea un resultado incierto con evidencia explícita de no aceptación", async () => {
    const row = await booking("RECONCILE", true);
    await test.db.insert(whatsappMessages).values({
      bookingId: row.id,
      type: "reminder",
      status: "unknown",
      attempts: 1,
    });
    expect(await reconcileNotice(test.db, row.id, "reminder", "not_sent", "no", null, NOW)).toBe(
      false,
    );
    expect(
      await reconcileNotice(
        test.db,
        row.id,
        "reminder",
        "not_sent",
        "Verificado que Meta no aceptó el mensaje",
        null,
        NOW,
      ),
    ).toBe(true);
    expect(
      (await sendNotice(test.db, row, "reminder", NOW, async () => "wamid.retry")).status,
    ).toBe("sent");
    const [audit] = await test.db.select().from(whatsappMessages);
    expect(audit?.attempts).toBe(2);
    expect(audit?.reconciliationNote).toContain("no aceptó");
  });

  it("no libera un sender aún activo y vuelve a validar la cancelación de la siguiente reserva", async () => {
    const first = await booking("FIRST", true);
    const second = await booking("SECOND", true);
    await test.db
      .update(bookings)
      .set({
        startsAt: new Date("2026-09-16T19:00:00Z"),
        endsAt: new Date("2026-09-16T19:30:00Z"),
      })
      .where(eq(bookings.id, second.id));
    let release = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sent: string[] = [];
    const job = sendPendingReminders(test.db, NOW, async (row) => {
      sent.push(row.code);
      if (row.id === first.id) {
        started();
        await held;
      }
      return `wamid.${row.code}`;
    });
    await entered;
    await test.db
      .update(whatsappMessages)
      .set({
        claimedAt: new Date(NOW.getTime() - 180000),
      })
      .where(eq(whatsappMessages.bookingId, first.id));
    expect(
      await reconcileNotice(
        test.db,
        first.id,
        "reminder",
        "not_sent",
        "No se confirma terminación real del proceso",
        null,
        NOW,
        true,
      ),
    ).toBe(false);
    await test.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, second.id));
    release();
    expect(await job).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(sent).toEqual(["FIRST"]);
  });

  it("envía plantilla Meta con parámetros posicionales sin exponer el token en el cuerpo", async () => {
    const row = await booking("META", true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "wamid.meta" }] }), { status: 200 }),
      );
    try {
      expect(await sendTemplate(row, "reminder")).toBe("wamid.meta");
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe("https://graph.facebook.com/v23.0/123456789/messages");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-only" });
      const body = JSON.parse(String(init?.body));
      expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
        "Ana",
        "16/09/2026",
        "15:00",
        "META",
      ]);
      expect(String(init?.body)).not.toContain("test-only");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
