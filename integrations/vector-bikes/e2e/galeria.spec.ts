import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { login, SEED } from "./fixtures.ts";

test("El mecánico sube una foto de trabajo terminado desde la galería", async ({ page }) => {
  await login(page, "mechanic");
  await page.goto(`/taller/ordenes/${SEED.orderControlId}/galeria`);
  const buffer = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#808080" },
  })
    .jpeg()
    .toBuffer();
  const input = page.getByLabel("Foto de trabajo terminado", { exact: true });
  await expect(input).toBeEnabled();
  const uploaded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/fotos"),
  );
  await input.setInputFiles({ name: "terminado.jpg", mimeType: "image/jpeg", buffer });
  expect((await uploaded).status()).toBe(201);
  const thumbnail = page
    .getByRole("region", { name: "Trabajo terminado", exact: true })
    .getByRole("img", { name: /^Foto de trabajo terminado \d+$/ })
    .last();
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute("src", /^\/taller\/media\//);
});
