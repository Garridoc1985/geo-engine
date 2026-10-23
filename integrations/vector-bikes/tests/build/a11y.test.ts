import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Chequeos estáticos sobre el HTML construido: sin DOM, solo expresiones regulares. */
const PAGES = ["index.html", "privacidad/index.html", "404.html"] as const;

function read(path: string): string {
  return readFileSync(`dist/client/${path}`, "utf8");
}

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
}

describe.each(PAGES)("accesibilidad estática de %s", (page) => {
  const html = read(page);

  it("declara el idioma es-CL", () => {
    expect(html).toContain('<html lang="es-CL"');
  });

  it("tiene exactamente un h1", () => {
    expect(html.split("<h1").length - 1).toBe(1);
  });

  it("no salta niveles de encabezado", () => {
    const levels = headingLevels(html);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1] ?? 1;
      const current = levels[index] ?? 1;
      expect(current - previous, `h${previous} → h${current}`).toBeLessThanOrEqual(1);
    }
  });

  it("toda imagen tiene alt", () => {
    const images = html.match(/<img\b[^>]*>/g) ?? [];
    for (const image of images) {
      expect(image).toMatch(/\balt=/);
    }
  });

  it("tiene el enlace para saltar al contenido", () => {
    expect(html).toContain('href="#contenido"');
    expect(html).toContain('id="contenido"');
  });
});

describe("formulario de la landing", () => {
  it("cada control visible con id tiene su label", () => {
    const html = read("index.html");
    const controls = html.match(/<(input|select|textarea)\b[^>]*>/g) ?? [];
    const ids = controls
      .filter((control) => !/type="hidden"/.test(control))
      .map((control) => control.match(/\bid="([^"]+)"/)?.[1])
      .filter((id): id is string => id !== undefined);

    for (const id of ids) {
      expect(html, `label for="${id}"`).toMatch(new RegExp(`<label\\b[^>]*for="${id}"`));
    }
  });
});

describe("CSS construido", () => {
  it("define foco visible y respeta prefers-reduced-motion", () => {
    const sheets = readdirSync("dist/client/_astro")
      .filter((file) => file.endsWith(".css"))
      .map((file) => read(`_astro/${file}`));

    expect(
      sheets.some(
        (css) => css.includes(":focus-visible") && css.includes("prefers-reduced-motion"),
      ),
    ).toBe(true);
  });
});
