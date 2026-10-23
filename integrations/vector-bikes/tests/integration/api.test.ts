import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HandlerContext,
  handleAvailability,
  handleCreateBooking,
} from "../../src/server/api/handlers.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookings } from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");

/** Turnstile nunca sale a la red en los tests. */
function fakeFetch(success: boolean): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    mode: "taller",
    service_date: "2026-09-16",
    start: "16:30",
    nombre: "Javiera Rojas",
    telefono: "+56 9 1111 1111",
    correo: "Javiera@Ejemplo.cl",
    bicicleta: "Ruta Specialized",
    descripcion: "Cambio de cadena y ajuste de frenos",
    consentimiento: true,
    turnstile_token: "token-de-prueba",
    ...overrides,
  };
}

function postRequest(payload: unknown): Request {
  return new Request("https://vectorbikes.cl/api/reservas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function countBookings(db: AppDb): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(bookings);
  return Number(row?.n ?? -1);
}

describe("API pública", () => {
  let test: TestDb;
  let ctx: HandlerContext;

  beforeEach(async () => {
    test = await createTestDb();
    ctx = { db: test.db, now: NOW, ip: "203.0.113.7", fetchFn: fakeFetch(true) };
    return () => test.close();
  });

  it("rechaza una reserva web sin correo con un error de validación 422", async () => {
    const onCreated = vi.fn(async () => {});
    const response = await handleCreateBooking(postRequest(body({ correo: undefined })), {
      ...ctx,
      onCreated,
    });

    expect(response.status).toBe(422);
    const payload = (await response.json()) as {
      code: string;
      fields: Record<string, string>;
    };
    expect(payload.code).toBe("validation_error");
    expect(payload.fields.correo).toBeDefined();
    expect(await countBookings(test.db)).toBe(0);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("entrega la disponibilidad del rango con los feriados marcados", async () => {
    const url = new URL(
      "https://vectorbikes.cl/api/disponibilidad?desde=2026-09-16&dias=4&modo=taller",
    );
    const response = await handleAvailability(url, ctx);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      timezone: string;
      capacity: number;
      days: { date: string; status: string; holidayName: string | null }[];
    };
    expect(payload.timezone).toBe("America/Santiago");
    expect(payload.capacity).toBe(4);
    expect(payload.days.map((day) => day.date)).toEqual([
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
    ]);
    expect(payload.days[2]?.status).toBe("holiday");
    expect(payload.days[3]?.status).toBe("holiday");
  });

  it("rechaza un rango mayor a 31 días", async () => {
    const url = new URL("https://vectorbikes.cl/api/disponibilidad?desde=2026-09-16&dias=40");
    const response = await handleAvailability(url, ctx);
    expect(response.status).toBe(422);

    const payload = (await response.json()) as { code: string; fields: Record<string, string> };
    expect(payload.code).toBe("validation_error");
    expect(payload.fields.dias).toBeDefined();
  });

  it("crea la reserva y avisa una sola vez después del commit", async () => {
    const onCreated = vi.fn(async () => {});
    const response = await handleCreateBooking(postRequest(body()), { ...ctx, onCreated });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      code: "VB-260916-1630",
      service_date: "2026-09-16",
      start: "16:30",
      end: "17:00",
      mode: "taller",
      fee: 0,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    const [booking] = await test.db
      .select({ whatsappConsentAt: bookings.whatsappConsentAt })
      .from(bookings);
    expect(booking?.whatsappConsentAt).toBeNull();
  });

  it("guarda el consentimiento opcional de WhatsApp enviado por la API", async () => {
    const response = await handleCreateBooking(
      postRequest(body({ whatsapp_consentimiento: true })),
      ctx,
    );
    expect(response.status).toBe(201);
    const [booking] = await test.db
      .select({ whatsappConsentAt: bookings.whatsappConsentAt })
      .from(bookings);
    expect(booking?.whatsappConsentAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("en retiro el servidor calcula el fin con los dos bloques", async () => {
    const retiro = body({
      mode: "retiro",
      start: "17:00",
      comuna: "Vitacura",
      direccion: "Av. Kennedy 7666",
    });
    const response = await handleCreateBooking(postRequest(retiro), ctx);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ start: "17:00", end: "18:00", mode: "retiro" });
  });

  it("nombra el campo inválido en el 422", async () => {
    const sinComuna = await handleCreateBooking(
      postRequest(body({ mode: "retiro", start: "16:00", direccion: "Av. Kennedy 7666" })),
      ctx,
    );
    expect(sinComuna.status).toBe(422);
    const primero = (await sinComuna.json()) as { fields: Record<string, string> };
    expect(primero.fields.comuna).toBe("Elige Vitacura o Las Condes.");

    const malTelefono = await handleCreateBooking(postRequest(body({ telefono: "12345" })), ctx);
    expect(malTelefono.status).toBe(422);
    const segundo = (await malTelefono.json()) as { fields: Record<string, string> };
    expect(segundo.fields.telefono).toBe("Faltan dígitos: son 8 después del +56 9.");
  });

  it("no reserva nada si Turnstile falla", async () => {
    const response = await handleCreateBooking(postRequest(body()), {
      ...ctx,
      fetchFn: fakeFetch(false),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "turnstile_failed",
    });
    expect(await countBookings(test.db)).toBe(0);
  });

  it("responde 409 cuando el bloque ya está tomado", async () => {
    await handleCreateBooking(postRequest(body()), ctx);
    const response = await handleCreateBooking(
      postRequest(body({ telefono: "+56 9 2222 2222" })),
      ctx,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "El bloque ya no está disponible",
      code: "slot_unavailable",
    });
  });

  it("corta en el sexto intento desde la misma IP", async () => {
    const sinTurnstile = { ...ctx, fetchFn: fakeFetch(false) };
    for (let index = 0; index < 5; index += 1) {
      const intento = await handleCreateBooking(postRequest(body()), sinTurnstile);
      expect(intento.status).toBe(403);
    }
    const sexto = await handleCreateBooking(postRequest(body()), ctx);
    expect(sexto.status).toBe(429);
    expect(sexto.headers.get("Retry-After")).toBe("600");
    expect((await sexto.json()) as { code: string; error: string }).toMatchObject({
      code: "rate_limited",
      error: "Demasiados intentos desde tu conexión. Vuelve a intentar en 10 minutos.",
    });
  });

  it("no cuenta los 422 para el límite por IP", async () => {
    for (let index = 0; index < 6; index += 1) {
      const invalido = await handleCreateBooking(postRequest(body({ telefono: "12345" })), ctx);
      expect(invalido.status).toBe(422);
    }
    const noJson = new Request("https://vectorbikes.cl/api/reservas", {
      method: "POST",
      body: "{",
    });
    expect((await handleCreateBooking(noJson, ctx)).status).toBe(422);
    expect((await handleCreateBooking(postRequest(body()), ctx)).status).toBe(201);
  });

  it("mantiene el 201 aunque el aviso post-commit falle", async () => {
    const onCreated = vi.fn(async () => {
      throw new Error("resend caído");
    });
    const response = await handleCreateBooking(postRequest(body()), { ...ctx, onCreated });
    expect(response.status).toBe(201);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
