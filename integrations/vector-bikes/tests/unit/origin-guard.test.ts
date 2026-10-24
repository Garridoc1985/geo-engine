import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

/**
 * El chequeo de Origin protege una sesión, no un token: va en admin y no en la cancelación.
 * Ver `.claude/rules/server-api.md` y `blueprints/vector-bikes/blueprint.md`.
 */
describe("chequeo de Origin por página", () => {
  const ADMIN = [
    "src/pages/admin/login.astro",
    "src/pages/admin/logout.ts",
    "src/pages/admin/bloqueos.astro",
    "src/pages/admin/reservas/[id].astro",
  ];

  for (const path of ADMIN) {
    it(`${path} exige Origin en el POST`, () => {
      expect(source(path)).toContain("isAllowedOrigin");
    });
  }

  it("la cancelación no exige Origin: el token es la defensa", () => {
    const cancel = source("src/pages/reservas/cancelar.astro");
    expect(cancel).not.toContain("isAllowedOrigin");
    expect(cancel).toContain("performCancellation");
  });

  it("la cancelación registra el origen recibido", () => {
    const cancel = source("src/pages/reservas/cancelar.astro");
    expect(cancel).toContain("originForLog");
    expect(cancel).toContain("cancel.origin");
  });
});
