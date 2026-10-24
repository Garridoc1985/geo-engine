import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";

// Infraestructura de pruebas: puede leer process.env (excepción declarada en .claude/rules/e2e.md).
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const DEFAULT_E2E_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/vector_bikes_e2e";

export const E2E_PORT = 4322;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || DEFAULT_E2E_DATABASE_URL;
export const E2E_STORAGE_DIR = ".storage-e2e";
export const E2E_TASKS_SECRET = "e2e-tasks-secret-0123456789abcdef0123";

/** Ids fijos de las filas que siembra `global-setup.ts`; los specs navegan con ellos. */
export const SEED = {
  branchId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000011",
  mechanicId: "00000000-0000-4000-8000-000000000012",
  bookingInicioId: "00000000-0000-4000-8000-000000000021",
  bookingCompletaId: "00000000-0000-4000-8000-000000000022",
  serviceMantencionId: "00000000-0000-4000-8000-000000000031",
  serviceFrenosId: "00000000-0000-4000-8000-000000000032",
  customerId: "00000000-0000-4000-8000-000000000041",
  bikeId: "00000000-0000-4000-8000-000000000051",
  orderRecibidaId: "00000000-0000-4000-8000-000000000061",
  orderControlId: "00000000-0000-4000-8000-000000000062",
  orderListaId: "00000000-0000-4000-8000-000000000063",
  itemListaId: "00000000-0000-4000-8000-000000000071",
} as const;

export const USERS = {
  owner: {
    email: "duenio@e2e.vectorbikes.cl",
    password: "e2e-clave-duenio-0001",
    name: "Dueño E2E",
  },
  mechanic: {
    email: "mecanico@e2e.vectorbikes.cl",
    password: "e2e-clave-mecanico-0001",
    name: "Mecánico E2E",
  },
} as const;

export type E2ERole = keyof typeof USERS;

/** Inicia sesión con toques y espera llegar a `next`. */
export async function login(page: Page, role: E2ERole, next = "/taller"): Promise<void> {
  const user = USERS[role];
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Clave").fill(user.password);
  await page.getByRole("button", { name: "Ingresar" }).tap();
  await page.waitForURL((url) => url.pathname === next);
}
