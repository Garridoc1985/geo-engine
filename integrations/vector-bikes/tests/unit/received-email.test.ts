import { describe, expect, it } from "vitest";
import { SITE } from "../../src/lib/site.ts";
import { formatClp, receivedBikeEmail } from "../../src/server/email/templates.ts";
import type { ReceivedBike } from "../../src/server/email/templates.ts";

const BASE: ReceivedBike = {
  orderNumber: "OT-00002",
  customerName: "Ana Pérez",
  bike: "Trek Marlin",
  requestedService: "Mantención general",
  items: [
    { description: "Ajuste de frenos", quantity: 1, unitPriceClp: 18000 },
    { description: "Cadena", quantity: 2, unitPriceClp: 12000 },
  ],
  accessories: ["Portabultos", "Luz trasera"],
  estimatedDeliveryDate: "2026-10-23",
  warrantyOfNumber: null,
};

function bodies(order: ReceivedBike) {
  const email = receivedBikeEmail(order);
  return { email, bodies: [email.text, email.html] };
}

describe("correo de bicicleta recibida", () => {
  it("el asunto lleva el número de orden y la marca", () => {
    expect(receivedBikeEmail(BASE).subject).toBe(
      `Recibimos tu bicicleta · OT-00002 · ${SITE.name}`,
    );
  });

  it("saluda por el primer nombre y nombra orden, bicicleta y servicio", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).toContain("Hola Ana");
      expect(body).not.toContain("Ana Pérez");
      expect(body).toContain("Tu bicicleta quedó registrada en el taller.");
      expect(body).toContain("OT-00002");
      expect(body).toContain("Trek Marlin");
      expect(body).toContain("Mantención general");
    }
  });

  it("lista las líneas cotizadas con su total", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).toContain("Ajuste de frenos");
      expect(body).toContain("Cadena");
      expect(body).toContain(formatClp(18000 + 2 * 12000));
      expect(body).not.toContain("Te enviaremos el presupuesto");
    }
  });

  it("sin líneas anuncia el presupuesto posterior", () => {
    for (const body of bodies({ ...BASE, items: [] }).bodies) {
      expect(body).toContain("Te enviaremos el presupuesto después del diagnóstico.");
    }
  });

  it("nombra los accesorios cuando los hay y los omite cuando no", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).toContain("Portabultos");
      expect(body).toContain("Luz trasera");
    }
    for (const body of bodies({ ...BASE, accessories: [] }).bodies) {
      expect(body).not.toContain("Portabultos");
      expect(body.toLowerCase()).not.toContain("accesorio");
    }
  });

  it("muestra la fecha estimada en formato largo", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).toContain("23 de octubre");
      expect(body).not.toContain("2026-10-23");
    }
  });

  it("sin fecha estimada no inventa una", () => {
    for (const body of bodies({ ...BASE, estimatedDeliveryDate: null }).bodies) {
      expect(body).not.toContain("23 de octubre");
      expect(body).not.toContain("null");
      expect(body).not.toContain("Invalid");
    }
  });

  it("menciona la garantía solo cuando la orden es de garantía", () => {
    for (const body of bodies({ ...BASE, warrantyOfNumber: "OT-00001" }).bodies) {
      expect(body).toContain("Orden de garantía de OT-00001");
    }
    for (const body of bodies(BASE).bodies) {
      expect(body.toLowerCase()).not.toContain("garantía");
    }
  });

  it("avisa que se contacta antes de un trabajo extra", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).toContain(
        "Si encontramos algo que no estaba en lo que pediste, te contactamos antes de hacerlo.",
      );
    }
  });

  it("no lleva enlaces, tokens ni notas internas", () => {
    for (const body of bodies(BASE).bodies) {
      expect(body).not.toContain("http://");
      expect(body).not.toContain("https://");
      expect(body.toLowerCase()).not.toContain("token");
      expect(body.toLowerCase()).not.toContain("checklist");
      expect(body.toLowerCase()).not.toContain("observaciones");
    }
  });

  it("escapa el HTML de los datos del cliente", () => {
    const email = receivedBikeEmail({ ...BASE, bike: 'Trek <script>"x"' });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
