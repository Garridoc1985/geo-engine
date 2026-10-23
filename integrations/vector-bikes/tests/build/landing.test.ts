import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { whatsappHref } from "../../src/lib/site.ts";

const html = readFileSync("dist/client/index.html", "utf8");

function occurrences(needle: string): number {
  return html.split(needle).length - 1;
}

/** El mismo valor que ve Vite al construir: primero el proceso, después `.env`. */
function buildTimeWhatsapp(): string | undefined {
  if (process.env.PUBLIC_WHATSAPP_NUMBER !== undefined) {
    return process.env.PUBLIC_WHATSAPP_NUMBER;
  }
  if (!existsSync(".env")) {
    return undefined;
  }
  return parseEnv(readFileSync(".env", "utf8")).PUBLIC_WHATSAPP_NUMBER;
}

describe("landing construida", () => {
  it("tiene un solo h1 con el título del prototipo", () => {
    expect(occurrences("<h1")).toBe(1);
    expect(html).toContain("<h1>Mecánica de precisión.</h1>");
  });

  it("ordena las secciones como el diseño aprobado", () => {
    const ids = ["como-funciona", "reservar", "retiro", "taller", "preguntas"];
    const positions = ids.map((id) => html.indexOf(`id="${id}"`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("muestra los datos de contacto del taller", () => {
    expect(html).toContain("Av. Kennedy 7666, Vitacura");
    expect(html).toContain("https://instagram.com/vector.bikes");
    expect(html).toContain("mailto:info@vectorbikes.cl");
    expect(html).toContain("query=Avenida+Kennedy+7666+Vitacura");
  });

  it("renderiza las dos escalas de horario en el servidor", () => {
    expect(occurrences('class="scale"')).toBe(2);
  });

  it("muestra el logo en la portada sin la cota de la rueda", () => {
    expect(html).toContain('<div class="mark"></div>');
    expect(html).not.toContain("622 MM");
  });

  it("renderiza WhatsApp solo si hay número configurado", () => {
    const href = whatsappHref(buildTimeWhatsapp());
    if (href === null) {
      expect(html).not.toContain('class="wa"');
    } else {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("normaliza el número de WhatsApp", () => {
    expect(whatsappHref(undefined)).toBeNull();
    expect(whatsappHref("")).toBeNull();
    expect(whatsappHref("+56 9 1234 5678")).toBe("https://wa.me/56912345678");
  });
});
