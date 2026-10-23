import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, expect, it, vi } from "vitest";
import { log } from "../../src/lib/log.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { bookingRequests, branches, users } from "../../src/server/db/schema.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { generateReport, viewReportByToken } from "../../src/server/taller/reports.ts";
import { newShareToken } from "../../src/server/taller/share-tokens.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({
  db: null as AppDb | null,
  storage: null as ObjectStorage | null,
}));
vi.mock("../../src/server/db/client.ts", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("Base de prueba no inicializada");
    return holder.db;
  },
}));
vi.mock("../../src/server/storage/storage.ts", () => ({
  getStorage: vi.fn(async () => {
    if (!holder.storage) throw new Error("Almacenamiento de prueba no inicializado");
    return holder.storage;
  }),
}));
vi.mock("../../src/server/taller/reports.ts", async (original) => {
  const reports = await original<typeof import("../../src/server/taller/reports.ts")>();
  return { ...reports, viewReportByToken: vi.fn(reports.viewReportByToken) };
});
const { default: ReportPage } = await import("../../src/pages/informe/[token].astro");
const SITE = "https://vectorbikes.cl";
const NOW = new Date("2026-10-09T15:00:00Z");
const INPUT = { recommendations: "Lubricar la cadena", nextChecks: "Revisar en seis meses" };
const PRIVATE = { phoneE164: "+56912345678", email: "ana@example.test", rut: "12.345.678-5" };
let test: TestDb;
let owner: SessionUser;
let orderId: string;
let token: string;

async function seedOwner() {
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta sucursal");
  const [user] = await test.db
    .insert(users)
    .values({
      branchId: branch.id,
      role: "owner",
      name: "Dueño",
      email: "owner@example.test",
      passwordHash: "hash",
    })
    .returning();
  if (!user) throw new Error("Falta usuario");
  owner = { id: user.id, branchId: branch.id, role: "owner", name: user.name, email: user.email };
}

async function seedOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: owner.branchId,
      name: "Ana María Pérez",
      ...PRIVATE,
    })
    .returning();
  if (!customer) throw new Error("Falta cliente");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer.id,
      brand: "Trek",
      model: "Marlin",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta bicicleta");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      status: "lista_para_retirar",
      requestedService: "Mantención",
      qcApprovedAt: NOW,
      receivedAt: NOW,
      diagnosis: "Cadena desgastada",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta orden");
  orderId = order.id;
}

async function generate() {
  const result = await generateReport(test.db, owner, orderId, INPUT, NOW);
  if (!result.ok) throw new Error(result.code);
  return result.token;
}

async function render(value = token, method = "GET", ip = "203.0.113.7", origin?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (origin) headers.origin = origin;
  const request = new Request(`${SITE}/informe/${value}`, { method, headers });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(ReportPage, { request, params: { token: value } });
}

async function responseBytes(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  const body = await response.text();
  expect(body).toContain('<meta name="robots" content="noindex">');
  return { status: response.status, headers: [...response.headers.entries()].sort(), body };
}

beforeEach(async () => {
  test = await createTestDb();
  holder.db = test.db;
  holder.storage = {
    get: async () => null,
    put: vi.fn<ObjectStorage["put"]>(),
    delete: vi.fn<ObjectStorage["delete"]>(),
    exists: async () => false,
  };
  await seedOwner();
  await seedOrder();
  token = await generate();
  vi.clearAllMocks();
  return async () => {
    holder.db = null;
    holder.storage = null;
    vi.restoreAllMocks();
    await test.close();
  };
});

it("5: inexistente, malformado y reemplazado dan 404 idénticos en estado, cabeceras y cuerpo", async () => {
  const superseded = token;
  token = await generate();
  const values = [newShareToken(), "invalido", superseded];
  const responses = [];
  for (const value of values) {
    const bytes = await responseBytes(await render(value));
    expect(bytes.status).toBe(404);
    expect(bytes.body).toContain("Enlace no válido");
    for (const secret of [...values, token, ...Object.values(PRIVATE)])
      expect(bytes.body).not.toContain(secret);
    responses.push(bytes);
  }
  expect(responses[1]).toEqual(responses[0]);
  expect(responses[2]).toEqual(responses[0]);
});

it.each([undefined, "https://visor.example.test/ruta?token=privado"])(
  "GET válido responde 200 sin datos sensibles, con Origin %s",
  async (origin) => {
    const info = vi.spyOn(log, "info");
    const bytes = await responseBytes(await render(token, "GET", "203.0.113.7", origin));
    expect(bytes.status).toBe(200);
    for (const text of [
      "Informe de servicio",
      "OT-00001",
      "Ana",
      "Trek Marlin",
      INPUT.recommendations,
      INPUT.nextChecks,
    ])
      expect(bytes.body).toContain(text);
    expect(bytes.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(bytes.body).not.toMatch(/<form\b|<header\b|<footer\b/);
    for (const secret of [token, ...Object.values(PRIVATE), "María", "Pérez"])
      expect(bytes.body).not.toContain(secret);
    expect(info).toHaveBeenCalledExactlyOnceWith("report.origin", {
      origin: origin ? "https://visor.example.test" : "ausente",
    });
    expect(await test.db.select().from(bookingRequests)).toEqual([]);
  },
);

it("6: cinco enlaces inválidos bloquean toda petición de esa IP sin consultar el informe", async () => {
  for (let index = 0; index < 5; index++)
    expect((await render(index % 2 ? "invalido" : newShareToken())).status).toBe(404);
  expect(await test.db.select().from(bookingRequests)).toHaveLength(5);
  vi.mocked(viewReportByToken).mockClear();
  for (const value of [token, newShareToken(), "invalido"]) {
    const response = await render(value);
    expect(response.headers.get("Retry-After")).toBe("600");
    const bytes = await responseBytes(response);
    expect(bytes.status).toBe(429);
    expect(bytes.body).toContain("Demasiados intentos. Vuelve a intentar en 10 minutos.");
    expect(bytes.body).not.toContain(value);
  }
  expect(viewReportByToken).not.toHaveBeenCalled();
  expect(await test.db.select().from(bookingRequests)).toHaveLength(5);
  expect((await render(token, "GET", "203.0.113.8")).status).toBe(200);
});

it("seis vistas válidas no consumen el límite ni registran intentos", async () => {
  for (let index = 0; index < 6; index++) expect((await render()).status).toBe(200);
  expect(viewReportByToken).toHaveBeenCalledTimes(6);
  expect(await test.db.select().from(bookingRequests)).toEqual([]);
});

it.each(["POST", "PUT", "PATCH", "DELETE"])(
  "%s recibe el mismo 404 fijo sin consultar el informe",
  async (method) => {
    const missing = await responseBytes(await render(newShareToken()));
    vi.mocked(viewReportByToken).mockClear();
    expect(await responseBytes(await render(token, method))).toEqual(missing);
    expect(viewReportByToken).not.toHaveBeenCalled();
    expect(await test.db.select().from(bookingRequests)).toHaveLength(1);
  },
);
