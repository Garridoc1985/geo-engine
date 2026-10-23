import { expect, test } from "@playwright/test";
import { login } from "./fixtures.ts";

test("El mecánico inicia una recepción y completa los siete puntos del checklist", async ({
  page,
}) => {
  await login(page, "mechanic");
  await page.goto("/taller/recepcion/nueva?q=Cliente Taller");
  await page.getByRole("link", { name: "Cliente Taller E2E", exact: true }).tap();
  await page
    .getByRole("group", { name: "Bicicleta", exact: true })
    .getByRole("radio", { name: /Specialized Rockhopper/ })
    .tap();
  await page.getByLabel("Servicio solicitado", { exact: true }).fill("Revisión general");
  await page.getByRole("button", { name: "Crear orden", exact: true }).tap();
  await expect(page).toHaveURL(/\/taller\/ordenes\/[0-9a-f-]{36}\/recepcion$/);
  for (const label of [
    "Frenos",
    "Cadena",
    "Transmisión",
    "Ruedas",
    "Neumáticos",
    "Estado general",
    "Problemas visibles",
  ]) {
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("radio", { name: "OK", exact: true })
      .tap();
  }
  await page.getByRole("button", { name: "Guardar checklist", exact: true }).tap();
  await expect(page).toHaveURL(/\/recepcion\?hecho=checklist$/);
  await expect(page.getByRole("status").filter({ hasText: /^Checklist completo$/ })).toBeVisible();
});
