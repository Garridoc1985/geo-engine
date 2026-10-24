import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("dist/client/index.html", "utf8");

describe("isla de reserva construida", () => {
  it("monta BookingIsland como isla de Astro", () => {
    expect(html).toContain("<astro-island");
    const island = /<astro-island[^>]*component-url="([^"]+)"/.exec(html);
    expect(island?.[1]).toContain("BookingIsland");
  });

  it("emite el formulario completo sin JavaScript", () => {
    for (const id of ["f-nombre", "f-tel", "f-mail", "f-bici", "f-desc", "f-comuna", "f-dir"]) {
      expect(html).toContain(`for="${id}"`);
    }
    expect(html).toContain('id="f-ok"');
  });

  it("el bundle construido lee la respuesta como texto y trae los mensajes de respaldo", () => {
    const island = /<astro-island[^>]*component-url="([^"]+)"/.exec(html)?.[1] ?? "";
    const bundle = readFileSync(`dist/client${island}`, "utf8");
    expect(bundle).toContain(".text()");
    expect(bundle).toContain("Demasiados intentos. Espera unos minutos e intenta de nuevo.");
  });

  it("el bundle construido carga Turnstile con render explícito y callback onload", () => {
    const island = /<astro-island[^>]*component-url="([^"]+)"/.exec(html)?.[1] ?? "";
    const bundle = readFileSync(`dist/client${island}`, "utf8");
    expect(bundle).toContain("render=explicit&onload=onloadTurnstileCallback");
    expect(bundle).toContain("No pudimos cargar la verificación anti-spam.");
  });

  it("muestra el ticket y el botón de envío", () => {
    expect(html).toContain("Orden de reserva");
    expect(html).toContain("Confirmar reserva");
  });
});
