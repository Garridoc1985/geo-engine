import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HandlerContext, handleCreateBooking } from "../../src/server/api/handlers.ts";
import { cancelBooking } from "../../src/server/booking/cancel-booking.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { Booking } from "../../src/server/db/schema.ts";
import {
  ICS_FILENAME,
  buildIcs,
  notifyBookingCancelled,
  notifyBookingCreated,
} from "../../src/server/email/notifications.ts";
import { escapeHtml, reminderEmail } from "../../src/server/email/templates.ts";
import {
  type EmailTransport,
  consoleOutbox,
  toResendPayload,
} from "../../src/server/email/transport.ts";
import { getEmailEnv } from "../../src/lib/env.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const SHOP = "info@vectorbikes.cl";

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

async function newBooking(
  test: TestDb,
  overrides: Partial<Parameters<typeof createBooking>[1]> = {},
) {
  const result = await createBooking(
    test.db,
    {
      mode: "retiro",
      serviceDate: "2026-09-16",
      start: "17:00",
      customerName: "Tomás <script>alert(1)</script>",
      phoneE164: "+56922222222",
      email: "tomas@ejemplo.cl",
      bike: "MTB Trek",
      description: "Frenos <script>alert('x')</script> y cambios",
      comuna: "Vitacura",
      address: "Av. Vitacura 1234",
      ipHash: null,
      ...overrides,
    },
    NOW,
  );
  if (!result.ok) {
    throw new Error(`no se pudo crear la reserva: ${result.code}`);
  }
  return result;
}

describe("correos transaccionales", () => {
  let test: TestDb;

  beforeEach(async () => {
    consoleOutbox.length = 0;
    // Cualquier intento de red hace fallar el test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("red deshabilitada en tests");
      }),
    );
    test = await createTestDb();
    return () => test.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sin correo envía solo el aviso al taller, sin adjunto ni error", async () => {
    const { booking, cancelToken } = await newBooking(test, { email: null });

    await expect(notifyBookingCreated(booking, cancelToken)).resolves.toBeUndefined();

    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(SHOP);
    expect(consoleOutbox[0]?.subject).toBe(`Nueva reserva ${booking.code}`);
    expect(consoleOutbox[0]?.text).toContain("Correo: Sin correo");
    expect(consoleOutbox[0]?.html).toContain("Sin correo");
    expect(consoleOutbox[0]?.attachments).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("muestra Sin correo en el aviso de cancelación al taller", async () => {
    const { booking } = await newBooking(test, { email: null });

    await notifyBookingCancelled(booking);

    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(SHOP);
    expect(consoleOutbox[0]?.text).toContain("Correo: Sin correo");
    expect(consoleOutbox[0]?.html).toContain("Sin correo");
  });

  it("encola 2 correos después del 201: cliente y taller", async () => {
    const turnstileFetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx: HandlerContext = {
      db: test.db,
      now: NOW,
      ip: "203.0.113.7",
      fetchFn: turnstileFetch,
      onCreated: notifyBookingCreated,
    };

    const response = await handleCreateBooking(postRequest(body()), ctx);

    expect(response.status).toBe(201);
    expect(consoleOutbox).toHaveLength(2);
    expect(consoleOutbox.map((entry) => entry.to).sort()).toEqual([SHOP, "javiera@ejemplo.cl"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("adjunta el .ics y el enlace de cancelación en la confirmación", async () => {
    const { booking, cancelToken } = await newBooking(test);
    await notifyBookingCreated(booking, cancelToken);

    const confirmation = consoleOutbox.find((entry) => entry.to === booking.email);
    expect(confirmation).toBeDefined();
    expect(confirmation?.subject).toContain("VB-260916-1700");
    expect(confirmation?.html).toContain("/reservas/cancelar?token=");
    expect(confirmation?.html).toContain(`token=${cancelToken}`);
    expect(confirmation?.html).toContain("Cancelar mi reserva");
    expect(confirmation?.text).toContain("17:00 a 18:00");
    expect(confirmation?.text).toContain("$15.000");

    const attachment = confirmation?.attachments?.[0];
    expect(attachment?.filename).toBe(ICS_FILENAME);
    expect(attachment?.content).toContain("BEGIN:VCALENDAR");
    expect(attachment?.content).toContain("DTSTART:20260916T200000Z");

    const shop = consoleOutbox.find((entry) => entry.to === SHOP);
    expect(shop?.text).toContain("+56922222222");
    expect(shop?.attachments).toBeUndefined();
  });

  it("escapa el texto del cliente en el HTML", async () => {
    const { booking, cancelToken } = await newBooking(test);
    await notifyBookingCreated(booking, cancelToken);

    expect(consoleOutbox).toHaveLength(2);
    for (const entry of consoleOutbox) {
      expect(entry.html).toContain("&lt;script&gt;");
      expect(entry.html).not.toContain("<script>");
    }
    expect(reminderEmail(booking).html).not.toContain("<script>");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("avisa al taller cuando se cancela una reserva", async () => {
    const { booking } = await newBooking(test);
    const cancelled = await cancelBooking(test.db, {
      bookingId: booking.id,
      by: "customer",
      now: NOW,
    });
    expect(cancelled.ok).toBe(true);
    const cancelledBooking = (cancelled as { ok: true; booking: Booking }).booking;

    await notifyBookingCancelled(cancelledBooking);

    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(SHOP);
    expect(consoleOutbox[0]?.subject).toContain("Reserva cancelada");
    expect(consoleOutbox[0]?.text).toContain("el cliente");
  });

  it("un fallo de envío se registra y no corta el aviso al taller", async () => {
    const { booking, cancelToken } = await newBooking(test);
    const sent: string[] = [];
    const flaky: EmailTransport = {
      send: async (outgoing) => {
        if (outgoing.to === booking.email) {
          throw new Error("buzón caído");
        }
        sent.push(outgoing.to);
      },
    };

    await expect(
      notifyBookingCreated(booking, cancelToken, { transport: flaky }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([SHOP]);
  });

  it("arma el payload de Resend con replyTo y adjunto en base64", async () => {
    const { booking } = await newBooking(test);
    if (booking.email === null) throw new Error("la reserva de prueba debe tener correo");
    const ics = buildIcs(booking);
    const env = { ...getEmailEnv(), EMAIL_TRANSPORT: "resend" as const, RESEND_API_KEY: "re_x" };

    const payload = toResendPayload(
      {
        to: booking.email,
        subject: "Prueba",
        html: "<p>hola</p>",
        text: "hola",
        attachments: [{ filename: ICS_FILENAME, content: ics, contentType: "text/calendar" }],
      },
      env,
    );

    expect(payload.from).toBe("Vector Bikes <reservas@send.vectorbikes.cl>");
    expect(payload.replyTo).toBe(SHOP);
    const decoded = Buffer.from(payload.attachments?.[0]?.content ?? "", "base64").toString();
    expect(decoded).toBe(ics);
  });
});
