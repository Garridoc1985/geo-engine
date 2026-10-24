import { expect, test } from "@playwright/test";
import { login } from "./fixtures.ts";

test("El mecánico ve sus bicicletas asignadas en el inicio del taller", async ({ page }) => {
  await login(page, "mechanic");
  await expect(
    page.getByRole("heading", { name: "Bicicletas asignadas", level: 2, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Bicicletas asignadas", exact: true }),
  ).toContainText("OT-00001");
});
