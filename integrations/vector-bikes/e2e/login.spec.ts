import { expect, test } from "@playwright/test";
import { login } from "./fixtures.ts";

test("Sin sesión, el taller redirige al ingreso", async ({ page }) => {
  await page.goto("/taller");
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Ftaller$/);
});

test("El dueño ingresa al taller desde la tablet", async ({ page }) => {
  await login(page, "owner");
  await expect(page.getByRole("heading", { name: "Taller", level: 1, exact: true })).toBeVisible();
  await expect(page.getByText("Dueño", { exact: true })).toBeVisible();
});

test("El mecánico no puede acceder a la agenda de administración", async ({ page }) => {
  await login(page, "mechanic");
  expect((await page.goto("/admin"))?.status()).toBe(403);
});
