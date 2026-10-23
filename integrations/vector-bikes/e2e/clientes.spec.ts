import { expect, test } from "@playwright/test";
import { login } from "./fixtures.ts";

test("El dueño crea un cliente y detecta un teléfono duplicado", async ({ page }) => {
  await login(page, "owner");
  await page.goto("/taller/clientes/nuevo");
  await page.getByLabel("Nombre", { exact: true }).fill("Laura Prueba");
  await page.getByLabel("Teléfono", { exact: true }).fill("9 5555 6666");
  await page.getByRole("button", { name: "Crear cliente", exact: true }).tap();
  await expect(
    page.getByRole("heading", { name: "Laura Prueba", level: 1, exact: true }),
  ).toBeVisible();

  await page.goto("/taller/clientes/nuevo");
  await page.getByLabel("Nombre", { exact: true }).fill("Otra Prueba");
  await page.getByLabel("Teléfono", { exact: true }).fill("9 5555 6666");
  await page.getByRole("button", { name: "Crear cliente", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("Ya existe: Laura Prueba");
  await expect(page.getByRole("link", { name: "Usar ficha existente", exact: true })).toBeVisible();
});

test("El mecánico no puede acceder a clientes", async ({ page }) => {
  await login(page, "mechanic");
  expect((await page.goto("/taller/clientes"))?.status()).toBe(403);
});
