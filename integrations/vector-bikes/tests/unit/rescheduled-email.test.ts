import { describe, expect, it } from "vitest";
import { SITE } from "../../src/lib/site.ts";
import { icsSequence } from "../../src/server/email/notifications.ts";
import type { Booking } from "../../src/server/db/schema.ts";
import { bookingRescheduledEmail, shopRescheduledEmail } from "../../src/server/email/templates.ts";

/** Reserva de taller el jueves 22 de octubre a las 16:00, movida desde el miércoles 21 a las 15:00. */
const BOOKING = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "VB-261021-1500",
  serviceDate: "2026-10-22",
  mode: "taller",
  status: "confirmed",
  source: "whatsapp",
  startsAt: new Date("2026-10-22T19:00:00.000Z"),
  endsAt: new Date("2026-10-22T19:30:00.000Z"),
  timezone: "America/Santiago",
  customerName: "Patricia Cruzat",
  phoneE164: "+56911112222",
  email: "patricia@ejemplo.cl",
  bike: "Urbana Oxford",
  description: "Mantención general",
  comuna: null,
  address: null,
  pickupFeeClp: 0,
  consentAt: new Date("2026-10-20T12:00:00.000Z"),
  whatsappConsentAt: null,
  cancelTokenHash: "hash",
  cancelTokenUsedAt: null,
  cancelledAt: null,
  cancelledBy: null,
  completedAt: null,
  reminderSentAt: null,
  ipHash: null,
  createdAt: new Date("2026-10-20T12:00:00.000Z"),
  updatedAt: new Date("2026-10-21T12:00:00.000Z"),
} as unknown as Booking;

const PREVIOUS = { serviceDate: "2026-10-21", start: "15:00" };

function bodies(booking: Booking = BOOKING) {
  const email = bookingRescheduledEmail(booking, PREVIOUS);
  return { email, bodies: [email.text, email.html] };
}

describe("correo de reserva reprogramada", () => {
  it("el asunto lleva el código y el taller", () => {
    expect(bodies().email.subject).toBe(`Cambiamos tu reserva · VB-261021-1500 · ${SITE.name}`);
  });

  it("muestra la fecha y hora anteriores y las nuevas, en formato largo", () => {
    for (const body of bodies().bodies) {
      expect(body).toContain("Hola Patricia");
      expect(body).toContain("21 de octubre");
      expect(body).toContain("15:00");
      expect(body).toContain("22 de octubre");
      expect(body).toContain("16:00");
      expect(body).not.toContain("2026-10-21");
      expect(body).not.toContain("2026-10-22");
    }
  });

  it("nombra la modalidad y, en retiro, la dirección", () => {
    for (const body of bodies().bodies) {
      expect(body).toContain("Entrega en el taller");
      expect(body).not.toContain("Av. Las Flores 123");
    }
    const retiro = {
      ...BOOKING,
      mode: "retiro",
      comuna: "Vitacura",
      address: "Av. Las Flores 123",
    };
    for (const body of bodies(retiro as Booking).bodies) {
      expect(body).toContain("Retiro a domicilio");
      expect(body).toContain("Av. Las Flores 123");
    }
  });

  // El token de cancelación se guarda solo como hash: el enlace no se puede regenerar.
  // Por eso se apunta al correo de confirmación, igual que hace el recordatorio.
  it("no inventa un enlace de cancelación y recuerda el del primer correo", () => {
    for (const body of bodies().bodies) {
      expect(body).not.toContain("http://");
      expect(body).not.toContain("https://");
      expect(body.toLowerCase()).not.toContain("token");
      expect(body).toContain("correo de confirmación");
    }
  });

  it("mantiene el mismo código: es la referencia que el cliente ya tiene", () => {
    for (const body of bodies().bodies) {
      expect(body).toContain("VB-261021-1500");
    }
  });

  it("escapa el HTML de los datos del cliente", () => {
    const email = bookingRescheduledEmail({ ...BOOKING, bike: 'Oxford <script>"x"' }, PREVIOUS);

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("el aviso al taller lleva el antes, el después y el contacto", () => {
    const email = shopRescheduledEmail(BOOKING, PREVIOUS);

    expect(email.subject).toContain("VB-261021-1500");
    expect(email.text).toContain("21 de octubre");
    expect(email.text).toContain("22 de octubre");
    expect(email.text).toContain("Patricia Cruzat");
    expect(email.text).toContain("+56911112222");
  });
});

describe("número de secuencia del calendario", () => {
  // El .ics original sale con SEQUENCE 0: si una reprogramación no lo supera, el calendario del
  // cliente ignora el cambio en silencio. Y si dos reprogramaciones no crecen entre sí, la segunda
  // se pierde igual. Esta es la propiedad de la que depende que el evento se mueva.
  it("siempre supera el cero y crece con cada actualización", () => {
    const primera = icsSequence(new Date("2026-10-21T12:00:00.000Z"));
    const segunda = icsSequence(new Date("2026-10-21T12:00:05.000Z"));

    expect(primera).toBeGreaterThan(0);
    expect(segunda).toBeGreaterThan(primera);
    expect(Number.isInteger(segunda)).toBe(true);
    expect(segunda).toBeLessThan(2_147_483_647);
  });

  it("una reserva creada y movida en el mismo segundo igual supera al evento original", () => {
    expect(icsSequence(new Date("2026-01-01T00:00:00.000Z"))).toBeGreaterThan(0);
  });
});
