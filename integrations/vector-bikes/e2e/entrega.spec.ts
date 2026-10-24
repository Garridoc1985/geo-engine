import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { login, SEED } from "./fixtures.ts";

async function drawSignature(page: Page) {
  const canvas = page.getByLabel("Firma de quien retira", { exact: true });
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("No se encontró el panel de firma.");
  const x = bounds.x + bounds.width * 0.2;
  const y = bounds.y + bounds.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + bounds.width * 0.15, y - 35, { steps: 12 });
  await page.mouse.move(x + bounds.width * 0.3, y + 35, { steps: 12 });
  await page.mouse.move(x + bounds.width * 0.5, y - 15, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByLabel("Firma registrada", { exact: true })).toHaveValue(
    /^data:image\/png;base64,/,
  );
}

test("El dueño registra el pago final y entrega la bicicleta con firma", async ({ page }) => {
  await login(page, "owner");
  await page.goto(`/taller/ordenes/${SEED.orderListaId}/entrega`);
  await expect(page.getByLabel("Nombre de quien retira", { exact: true })).toHaveValue(
    "Cliente Taller E2E",
  );
  await page
    .getByRole("group", { name: "Tipo de pago", exact: true })
    .getByRole("radio", { name: "Pago final", exact: true })
    .tap();
  await page
    .getByRole("group", { name: "Método", exact: true })
    .getByRole("radio", { name: "Transferencia", exact: true })
    .tap();
  await page.getByLabel("Monto", { exact: true }).fill("25000");
  await page.getByRole("button", { name: "Registrar pago", exact: true }).tap();
  await expect(page).toHaveURL(/\/entrega\?hecho=record$/);
  await expect(
    page
      .getByRole("term")
      .filter({ hasText: /^Saldo$/ })
      .locator("+ dd"),
  ).toHaveText("$0");
  await expect(page.getByRole("button", { name: "Registrar pago", exact: true })).toHaveCount(0);
  await drawSignature(page);
  await page.getByRole("button", { name: "Entregar bicicleta", exact: true }).tap();
  await expect(page).toHaveURL(/\/entrega\?hecho=deliver$/);
  await expect(page.locator("span.status")).toHaveText("Entregada");
  await expect(page.getByRole("status")).toHaveText("Bicicleta entregada.");
  await expect(page.getByRole("button", { name: "Entregar bicicleta", exact: true })).toHaveCount(
    0,
  );
});
