import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../../src/server/db/client.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({ db: null as AppDb | null }));

vi.mock("../../src/server/db/client.ts", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("base de prueba no inicializada");
    return holder.db;
  },
}));

const { default: LoginPage } = await import("../../src/pages/admin/login.astro");

const SITE = "https://vectorbikes.cl";
const NEXT = "/taller/ordenes/0b6f1c2e-6a39-4c38-9a0f-3c1f5c0b9e11";

/** Valor del campo oculto `next`; Astro escribe `value=""` como el atributo `value` sin comillas. */
function hiddenNext(html: string): string | undefined {
  const input = html.match(/<input[^>]*name="next"[^>]*>/)?.[0];
  if (!input) return undefined;
  return input.match(/\svalue="([^"]*)"/)?.[1] ?? (/\svalue[\s/>]/.test(input) ? "" : undefined);
}

async function render(request: Request): Promise<string> {
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToString(LoginPage, { request });
}

function failedLogin(next: string): Request {
  const body = new URLSearchParams({
    email: "nadie@ejemplo.cl",
    password: "clave-equivocada",
    next,
  });
  return new Request(`${SITE}/admin/login`, {
    method: "POST",
    headers: {
      origin: SITE,
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.7",
    },
    body,
  });
}

describe("login de /admin y el parámetro next", () => {
  let test: TestDb;

  beforeEach(async () => {
    test = await createTestDb();
    holder.db = test.db;
    return async () => {
      holder.db = null;
      await test.close();
    };
  });

  it("pone el next del enlace en el formulario", async () => {
    const html = await render(new Request(`${SITE}/admin/login?next=${encodeURIComponent(NEXT)}`));
    expect(hiddenNext(html)).toBe(NEXT);
  });

  it("conserva el next después de un intento fallido", async () => {
    const html = await render(failedLogin(NEXT));
    expect(html).toContain("Correo o clave incorrectos.");
    expect(hiddenNext(html)).toBe(NEXT);
  });

  it("descarta un next que no es una ruta interna", async () => {
    const fromQuery = await render(new Request(`${SITE}/admin/login?next=%2F%2Fevil.com`));
    expect(hiddenNext(fromQuery)).toBe("");
    const afterFailure = await render(failedLogin("https://evil.com/taller"));
    expect(hiddenNext(afterFailure)).toBe("");
  });
});
