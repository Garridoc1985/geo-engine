import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin, originForLog } from "../../src/server/api/handlers.ts";
import { performCancellation, viewCancellation } from "../../src/server/booking/cancel-flow.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookingBlocks, bookings } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
/** 2026-09-16 17:00 hora local: empieza la reserva de retiro. */
const STARTED = new Date("2026-09-16T20:00:00.000Z");
const SHOP = "info@vectorbikes.cl";

async function newBooking(db: AppDb) {
  const result = await createBooking(
    db,
    {
      mode: "retiro",
      serviceDate: "2026-09-16",
      start: "17:00",
      customerName: "Tomás Pérez",
      phoneE164: "+56922222222",
      email: "tomas@ejemplo.cl",
      bike: "MTB Trek",
      description: "Ajuste de cambios",
      comuna: "Vitacura",
      address: "Av. Vitacura 1234",
      ipHash: null,
    },
    NOW,
  );
  if (!result.ok) {
    throw new Error(`no se pudo crear la reserva: ${result.code}`);
  }
  return result;
}

/** Huella de todas las filas que la cancelación puede tocar. */
async function snapshot(db: AppDb) {
  const rows = await db.select().from(bookings);
  const blocks = await db.select().from(bookingBlocks);
  return JSON.stringify({ rows, blocks });
}

describe("cancelación con token", () => {
  let test: TestDb;

  beforeEach(async () => {
    consoleOutbox.length = 0;
    test = await createTestDb();
    return () => test.close();
  });

  it("muestra la confirmación sin cambiar nada", async () => {
    const { cancelToken } = await newBooking(test.db);
    const before = await snapshot(test.db);

    const view = await viewCancellation(test.db, cancelToken, NOW);

    expect(view.view).toBe("confirm");
    expect("booking" in view && view.booking.code).toBe("VB-260916-1700");
    expect("booking" in view && `${view.booking.start}-${view.booking.end}`).toBe("17:00-18:00");
    expect(await snapshot(test.db)).toBe(before);
    expect(consoleOutbox).toHaveLength(0);
  });

  it("cancela, libera los bloques y avisa una vez al taller", async () => {
    const { booking, cancelToken } = await newBooking(test.db);

    const view = await performCancellation(test.db, cancelToken, NOW);

    expect(view.view).toBe("done");
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledBy).toBe("customer");
    expect(row?.cancelTokenUsedAt?.toISOString()).toBe(NOW.toISOString());
    const [active] = await test.db
      .select({ n: sql<number>`count(*)` })
      .from(bookingBlocks)
      .where(eq(bookingBlocks.isActive, true));
    expect(Number(active?.n)).toBe(0);
    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(SHOP);
    expect(consoleOutbox[0]?.subject).toContain("Reserva cancelada");
  });

  it("permite ver y cancelar una reserva futura lista para retiro", async () => {
    const { booking, cancelToken } = await newBooking(test.db);
    await test.db
      .update(bookings)
      .set({ status: "ready_for_pickup" })
      .where(eq(bookings.id, booking.id));

    expect((await viewCancellation(test.db, cancelToken, NOW)).view).toBe("confirm");
    expect((await performCancellation(test.db, cancelToken, NOW)).view).toBe("done");

    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
  });

  it("un segundo envío del mismo token no escribe ni envía nada", async () => {
    const { cancelToken } = await newBooking(test.db);
    await performCancellation(test.db, cancelToken, NOW);
    consoleOutbox.length = 0;
    const before = await snapshot(test.db);

    const again = await performCancellation(test.db, cancelToken, NOW);

    expect(again.view).toBe("cancelled");
    expect(await snapshot(test.db)).toBe(before);
    expect(consoleOutbox).toHaveLength(0);
    expect((await viewCancellation(test.db, cancelToken, NOW)).view).toBe("cancelled");
  });

  it("una reserva que ya empezó no se cancela", async () => {
    const { booking, cancelToken } = await newBooking(test.db);

    expect((await viewCancellation(test.db, cancelToken, STARTED)).view).toBe("started");
    const view = await performCancellation(test.db, cancelToken, STARTED);

    expect(view.view).toBe("started");
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("confirmed");
    expect(row?.cancelTokenUsedAt).toBeNull();
    expect(consoleOutbox).toHaveLength(0);
  });

  it("un token inexistente o mal formado es inválido", async () => {
    await newBooking(test.db);
    const unknown = "a".repeat(43);

    expect(await viewCancellation(test.db, unknown, NOW)).toEqual({ view: "invalid" });
    expect(await performCancellation(test.db, unknown, NOW)).toEqual({ view: "invalid" });
    expect(await viewCancellation(test.db, "corto", NOW)).toEqual({ view: "invalid" });
    expect(await viewCancellation(test.db, null, NOW)).toEqual({ view: "invalid" });
    expect(consoleOutbox).toHaveLength(0);
  });

  it("un fallo del aviso al taller no revierte la cancelación", async () => {
    const { booking, cancelToken } = await newBooking(test.db);
    const notify = vi.fn(async () => {
      throw new Error("sin conexión");
    });

    const view = await performCancellation(test.db, cancelToken, NOW, { notify });

    expect(view.view).toBe("done");
    expect(notify).toHaveBeenCalledTimes(1);
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
  });
});

/**
 * El POST de /reservas/cancelar ya no exige `Origin`: el token del correo es la defensa.
 * Estas pruebas reproducen el camino de la página con peticiones reales.
 */
describe("POST de cancelación sin Origin", () => {
  let test: TestDb;

  beforeEach(async () => {
    consoleOutbox.length = 0;
    test = await createTestDb();
    return () => test.close();
  });

  /** Lo que hace la página: leer el token del formulario, sin mirar el origen. */
  const postWith = (token: string, headers: Record<string, string> = {}) => {
    const body = new FormData();
    body.set("token", token);
    return new Request("https://vectorbikes.cl/reservas/cancelar", {
      method: "POST",
      headers,
      body,
    });
  };

  async function submit(request: Request) {
    const form = await request.formData();
    const raw = form.get("token");
    return performCancellation(test.db, typeof raw === "string" ? raw : null, NOW);
  }

  it("un token válido cancela aunque no venga la cabecera Origin", async () => {
    const { cancelToken, booking } = await newBooking(test.db);

    const result = await submit(postWith(cancelToken));

    expect(result.view).toBe("done");
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
  });

  it("un token válido cancela con el Origin de un visor de correo", async () => {
    const { cancelToken, booking } = await newBooking(test.db);

    const result = await submit(postWith(cancelToken, { origin: "https://mail.google.com" }));

    expect(result.view).toBe("done");
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
  });

  it("un token inválido sigue fallando sin tocar nada", async () => {
    await newBooking(test.db);
    const before = await snapshot(test.db);

    expect(await submit(postWith("a".repeat(43)))).toEqual({ view: "invalid" });
    expect(await submit(postWith("corto"))).toEqual({ view: "invalid" });
    expect(await submit(postWith("", { origin: "https://vectorbikes.cl" }))).toEqual({
      view: "invalid",
    });

    expect(await snapshot(test.db)).toBe(before);
    expect(consoleOutbox).toHaveLength(0);
  });
});

describe("originForLog", () => {
  const post = (origin?: string) =>
    new Request("https://vectorbikes.cl/reservas/cancelar", {
      method: "POST",
      headers: origin === undefined ? {} : { origin },
    });

  it("registra solo el origen, nunca la ruta ni la consulta", () => {
    expect(originForLog(post("https://mail.google.com"))).toBe("https://mail.google.com");
    expect(originForLog(post("https://www.vectorbikes.cl"))).toBe("https://www.vectorbikes.cl");
    expect(originForLog(post("http://localhost:4321"))).toBe("http://localhost:4321");
  });

  it("distingue ausente, opaco y no válido", () => {
    expect(originForLog(post())).toBe("ausente");
    expect(originForLog(post(""))).toBe("ausente");
    expect(originForLog(post("null"))).toBe("null");
    expect(originForLog(post("basura"))).toBe("no-valido");
  });
});

describe("isAllowedOrigin", () => {
  const site = "https://vectorbikes.cl";
  const post = (origin?: string) =>
    new Request(`${site}/reservas/cancelar`, {
      method: "POST",
      headers: origin === undefined ? {} : { origin },
    });

  it("acepta el origin de PUBLIC_SITE_URL sin www", () => {
    expect(isAllowedOrigin(post("https://vectorbikes.cl"), site)).toBe(true);
    expect(isAllowedOrigin(post("https://vectorbikes.cl"))).toBe(true);
    expect(isAllowedOrigin(post("https://vectorbikes.cl"), "https://www.vectorbikes.cl")).toBe(
      true,
    );
  });

  it("acepta el mismo origin con www", () => {
    expect(isAllowedOrigin(post("https://www.vectorbikes.cl"), site)).toBe(true);
    expect(isAllowedOrigin(post("https://www.vectorbikes.cl"))).toBe(true);
    expect(isAllowedOrigin(post("https://www.vectorbikes.cl"), "https://www.vectorbikes.cl")).toBe(
      true,
    );
  });

  it("rechaza otro dominio", () => {
    expect(isAllowedOrigin(post("https://evil.example"), site)).toBe(false);
    expect(isAllowedOrigin(post("https://www.evil.example"), site)).toBe(false);
    expect(isAllowedOrigin(post("https://vectorbikes.cl.evil.example"), site)).toBe(false);
    expect(isAllowedOrigin(post("https://wwwvectorbikes.cl"), site)).toBe(false);
    expect(isAllowedOrigin(post("https://www.www.vectorbikes.cl"), site)).toBe(false);
  });

  it("rechaza sin cabecera Origin", () => {
    expect(isAllowedOrigin(post(), site)).toBe(false);
    expect(isAllowedOrigin(post(""), site)).toBe(false);
    expect(isAllowedOrigin(post("null"), site)).toBe(false);
  });

  it("mantiene esquema y puerto", () => {
    expect(isAllowedOrigin(post("http://vectorbikes.cl"), site)).toBe(false);
    expect(isAllowedOrigin(post("http://www.vectorbikes.cl"), site)).toBe(false);
    expect(isAllowedOrigin(post("https://vectorbikes.cl:8443"), site)).toBe(false);
    expect(isAllowedOrigin(post("http://localhost:4321"), "http://localhost:4321")).toBe(true);
    expect(isAllowedOrigin(post("http://www.localhost:4321"), "http://localhost:4321")).toBe(true);
    expect(isAllowedOrigin(post("http://localhost:3000"), "http://localhost:4321")).toBe(false);
  });
});
