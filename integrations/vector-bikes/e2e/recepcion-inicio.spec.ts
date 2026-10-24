import { expect, test } from "@playwright/test";
import { login } from "./fixtures.ts";

test("El dueño inicia la recepción desde una reserva y el mecánico no accede a reservas", async ({
  page,
  browser,
}) => {
  await login(page, "owner");
  await page.goto("/taller/reservas");
  const bookingRow = page.getByRole("row", { name: /Carla Reserva/ });
  await bookingRow.getByRole("link", { name: "Recibir", exact: true }).tap();
  await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Carla Reserva");
  await expect(page.getByLabel("Teléfono", { exact: true })).not.toHaveValue("");
  await expect(page.getByLabel("Correo", { exact: true })).not.toHaveValue("");
  await page.getByRole("radio", { name: "MTB", exact: true }).tap();
  await page.getByRole("button", { name: "Crear orden", exact: true }).tap();
  await expect(page).toHaveURL(/\/taller\/ordenes\/[0-9a-f-]{36}\/recepcion$/);
  const orderHeading = page.getByRole("heading", { name: /OT-\d{5}/, level: 1 });
  await expect(orderHeading).toBeVisible();
  await expect(page.getByText("Carla Reserva", { exact: true })).toBeVisible();
  const orderNumber = await orderHeading.innerText();
  const receptionUrl = page.url();
  await page.goto("/taller/reservas");
  const orderLink = bookingRow.getByRole("link", { name: orderNumber, exact: true });
  await expect(orderLink).toHaveAttribute("href", new URL(receptionUrl).pathname);
  await expect(bookingRow.getByRole("link", { name: "Recibir", exact: true })).toHaveCount(0);

  const mechanicContext = await browser.newContext({ hasTouch: true });
  try {
    const mechanicPage = await mechanicContext.newPage();
    await login(mechanicPage, "mechanic");
    expect((await mechanicPage.goto("/taller/reservas"))?.status()).toBe(403);
  } finally {
    await mechanicContext.close();
  }
});

test("El mecánico recibe una bicicleta con cliente nuevo sin visitar clientes", async ({
  page,
}) => {
  const navigatedUrls: string[] = [];
  page.on("framenavigated", (frame) => navigatedUrls.push(frame.url()));
  await login(page, "mechanic");
  await page.goto("/taller/recepcion/nueva");
  await page.getByLabel("Nombre", { exact: true }).fill("Martín Taller");
  await page.getByLabel("Teléfono", { exact: true }).fill("9 4444 7777");
  await page.getByLabel("Marca", { exact: true }).fill("Giant");
  await page.getByLabel("Modelo", { exact: true }).fill("Talon 2");
  await page.getByRole("radio", { name: "MTB", exact: true }).tap();
  await page.getByLabel("Servicio solicitado", { exact: true }).fill("Mantención general");
  await page.getByRole("button", { name: "Crear orden", exact: true }).tap();
  await expect(page).toHaveURL(/\/taller\/ordenes\/[0-9a-f-]{36}\/recepcion$/);
  await expect(page.getByRole("heading", { name: /OT-\d{5}/, level: 1 })).toBeVisible();
  await expect(page.getByText("Martín Taller", { exact: true })).toBeVisible();
  expect(navigatedUrls.some((url) => url.includes("/taller/clientes"))).toBe(false);
});
