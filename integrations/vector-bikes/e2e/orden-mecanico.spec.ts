import { expect, test } from "@playwright/test";
import { login, SEED } from "./fixtures.ts";

test("el mecánico pasa OT-00001 de Recibida a Diagnóstico", async ({ page }) => {
  await login(page, "mechanic");
  await page.goto(`/taller/ordenes/${SEED.orderRecibidaId}`);
  await expect(page.getByRole("heading", { name: "OT-00001", exact: true })).toBeVisible();
  await expect(page.locator(".status--recibida")).toHaveText("Recibida");
  await page.getByLabel("Estado", { exact: true }).selectOption("diagnostico");
  await page.getByRole("button", { name: "Actualizar estado", exact: true }).tap();
  await expect(page.locator(".status--diagnostico")).toHaveText("Diagnóstico");
  await expect(page.getByRole("status")).toHaveText("Cambios guardados.");
});
