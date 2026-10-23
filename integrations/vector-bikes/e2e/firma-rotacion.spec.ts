import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { login } from "./fixtures.ts";

const PORTRAIT = { width: 820, height: 1180 };
const LANDSCAPE = { width: 1180, height: 820 };

/** Crea una orden propia para no depender de las reservas que usan los otros specs. */
async function createOrder(page: Page, name: string, phone: string): Promise<void> {
  await login(page, "owner");
  await page.goto("/taller/recepcion/nueva");
  await page.getByLabel("Nombre", { exact: true }).fill(name);
  await page.getByLabel("Teléfono", { exact: true }).fill(phone);
  await page.getByLabel("Marca", { exact: true }).fill("Cannondale");
  await page.getByLabel("Modelo", { exact: true }).fill("Topstone");
  await page.getByRole("radio", { name: "Gravel", exact: true }).tap();
  await page.getByLabel("Servicio solicitado", { exact: true }).fill("Mantención general");
  await page.getByRole("button", { name: "Crear orden", exact: true }).tap();
  await expect(page).toHaveURL(/\/taller\/ordenes\/[0-9a-f-]{36}\/recepcion$/);
}

async function drawSignature(page: Page): Promise<void> {
  const canvas = page.getByLabel("Firma del cliente", { exact: true });
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

function canvasWidth(page: Page): Promise<number> {
  return page
    .getByLabel("Firma del cliente", { exact: true })
    .evaluate((canvas) => (canvas as HTMLCanvasElement).offsetWidth);
}

/** Deja pasar dos cuadros: el navegador entrega los avisos de tamaño antes de pintar. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function completeChecklist(page: Page): Promise<void> {
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
  await expect(page.getByRole("status").filter({ hasText: /^Checklist completo$/ })).toBeVisible();
}

async function uploadOnePhoto(page: Page): Promise<void> {
  const buffer = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 80, g: 110, b: 150 } },
  })
    .jpeg()
    .toBuffer();
  const input = page.getByLabel("Tomar foto", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles([{ name: "recepcion-1.jpg", mimeType: "image/jpeg", buffer }]);
  await expect(page.getByRole("img", { name: "Foto de recepción 1", exact: true })).toHaveAttribute(
    "src",
    /^\/taller\/media\//,
  );
}

function signatureInput(page: Page): Locator {
  return page.getByLabel("Firma registrada", { exact: true });
}

test("La firma sobrevive a girar la tablet y la recepción se finaliza", async ({ page }) => {
  await createOrder(page, "Rotación Firma", "9 4444 1111");
  await completeChecklist(page);
  await page.getByRole("button", { name: "Confirmar fecha", exact: true }).tap();
  await expect(page.getByRole("status").filter({ hasText: /^Fecha confirmada:/ })).toBeVisible();
  await page.getByRole("link", { name: "Continuar a fotos y firma", exact: true }).tap();
  await expect(page).toHaveURL(/\/cierre$/);
  await uploadOnePhoto(page);
  await page.getByLabel("Nombre de quien firma", { exact: true }).fill("Rotación Firma");
  await drawSignature(page);
  const portraitValue = await signatureInput(page).inputValue();
  const portraitWidth = await canvasWidth(page);

  await page.setViewportSize(LANDSCAPE);

  // El canvas se ensancha de verdad: la firma se vuelve a dibujar a la nueva escala.
  await expect.poll(() => canvasWidth(page)).toBeGreaterThan(portraitWidth);
  await expect(signatureInput(page)).toHaveValue(/^data:image\/png;base64,/);
  await expect(signatureInput(page)).not.toHaveValue(portraitValue);

  await page.setViewportSize(PORTRAIT);

  await expect.poll(() => canvasWidth(page)).toBe(portraitWidth);
  await expect(signatureInput(page)).toHaveValue(/^data:image\/png;base64,/);

  await page.getByRole("button", { name: "Finalizar recepción", exact: true }).tap();
  await expect(page).toHaveURL(/\/recepcion\?hecho=recibida$/);
  await expect(page.getByText("Recibida", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Un cambio de alto sin cambio de ancho deja la firma intacta", async ({ page }) => {
  await createOrder(page, "Scroll Firma", "9 4444 2222");
  await page.goto(`${new URL(page.url()).pathname.replace(/\/recepcion$/, "")}/cierre`);
  await drawSignature(page);
  const value = await signatureInput(page).inputValue();
  const width = await canvasWidth(page);

  // Lo que hace Safari al ocultar su barra al desplazarse: avisa de un resize sin tocar el ancho.
  await page.setViewportSize({ width: PORTRAIT.width, height: 900 });
  await settle(page);

  expect(await canvasWidth(page)).toBe(width);
  expect(await signatureInput(page).inputValue()).toBe(value);
});
