import { expect, test } from "@playwright/test";
import { login, SEED } from "./fixtures.ts";

test("el dueño abre la etiqueta y sigue la URL del QR a la orden", async ({ page }) => {
  await login(page, "owner", `/taller/ordenes/${SEED.orderRecibidaId}/etiqueta`);
  await expect(page.getByRole("heading", { name: "OT-00001", exact: true })).toBeVisible();
  await expect(page.locator("svg")).toBeVisible();
  const qrUrl = await page.locator(".qr").getAttribute("data-qr-url");
  expect(qrUrl).toBeTruthy();
  if (!qrUrl) throw new Error("Falta la URL del QR.");
  await page.goto(qrUrl);
  await expect(page.getByRole("heading", { name: "OT-00001", exact: true })).toBeVisible();
});
