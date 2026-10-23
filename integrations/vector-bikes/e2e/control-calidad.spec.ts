import { expect, test } from "@playwright/test";
import { login, SEED } from "./fixtures.ts";

test("El dueño aprueba los siete puntos del control de calidad", async ({ page }) => {
  await login(page, "owner");
  await page.goto(`/taller/ordenes/${SEED.orderControlId}/control`);
  for (const label of [
    "Frenos",
    "Cambios",
    "Ruedas",
    "Apriete de componentes",
    "Neumáticos y presión",
    "Prueba de rodaje",
    "Limpieza",
  ]) {
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("radio", { name: "OK", exact: true })
      .tap();
  }
  await page.getByRole("button", { name: "Aprobar control", exact: true }).tap();
  await expect(page).toHaveURL(/\/control\?hecho=aprobado$/);
  await expect(page.locator("span.status")).toHaveText("Lista para retirar");
});
