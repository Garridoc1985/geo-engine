import { describe, expect, it } from "vitest";
import { SITE } from "../../src/lib/site.ts";
import { RECEPTION_HOURS } from "../../src/server/booking/rules.ts";
import { formatClp, readyForPickupEmail } from "../../src/server/email/templates.ts";
import type { ReadyForPickup } from "../../src/server/email/templates.ts";

const BASE: ReadyForPickup = {
  orderNumber: "OT-00001",
  customerName: "Ana Pérez",
  bike: "Trek Marlin",
  totalClp: 45000,
  paidClp: 20000,
};

function both(order: ReadyForPickup) {
  const email = readyForPickupEmail(order);
  return { ...email, bodies: [email.text, email.html] };
}

describe("correo de bicicleta lista para retirar", () => {
  it("el asunto lleva el número de orden y la marca", () => {
    expect(readyForPickupEmail(BASE).subject).toBe(
      `Tu bicicleta está lista para retirar · OT-00001 · ${SITE.name}`,
    );
  });

  it("saluda por el primer nombre y nombra la orden y la bicicleta", () => {
    const { bodies } = both(BASE);

    for (const body of bodies) {
      expect(body).toContain("Hola Ana");
      expect(body).not.toContain("Ana Pérez");
      expect(body).toContain("OT-00001");
      expect(body).toContain("Trek Marlin");
    }
  });

  it("con saldo pendiente muestra total, pagado y saldo", () => {
    const { bodies } = both(BASE);

    for (const body of bodies) {
      expect(body).toContain(formatClp(45000));
      expect(body).toContain(formatClp(20000));
      expect(body).toContain(formatClp(25000));
      expect(body).not.toContain("Pagado");
    }
  });

  it("sin saldo dice Pagado en vez de un monto pendiente", () => {
    const { bodies } = both({ ...BASE, paidClp: BASE.totalClp });

    for (const body of bodies) {
      expect(body).toContain("Pagado");
    }
  });

  it("el horario sale de RECEPTION_HOURS y la dirección de SITE", () => {
    const week = RECEPTION_HOURS[1];
    const saturday = RECEPTION_HOURS[6];
    if (!week || !saturday) throw new Error("Faltan los horarios de recepción.");
    const { bodies } = both(BASE);

    for (const body of bodies) {
      expect(body).toContain(week.open);
      expect(body).toContain(week.close);
      expect(body).toContain(saturday.open);
      expect(body).toContain(saturday.close);
      expect(body.toLowerCase()).toContain("domingo");
      expect(body).toContain(SITE.streetAddress);
      expect(body).toContain(SITE.locality);
    }
  });

  it("nombra los medios de pago y la devolución a domicilio", () => {
    const { bodies } = both(BASE);

    for (const body of bodies) {
      const lower = body.toLowerCase();
      expect(lower).toContain("efectivo");
      expect(lower).toContain("transferencia");
      expect(lower).toContain("tarjeta");
      expect(body).toContain(
        "Si coordinamos la devolución a domicilio, te llamaremos para acordar la hora.",
      );
    }
  });

  it("no lleva ningún enlace con token ni al informe", () => {
    const { bodies } = both(BASE);

    for (const body of bodies) {
      expect(body).not.toContain("/informe/");
      expect(body).not.toContain("/aprobacion/");
      expect(body.toLowerCase()).not.toContain("token");
      expect(body).not.toContain("http://");
      expect(body).not.toContain("https://");
    }
  });

  it("escapa el HTML de los datos del cliente", () => {
    const email = readyForPickupEmail({ ...BASE, bike: 'Trek <script>"x"' });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
