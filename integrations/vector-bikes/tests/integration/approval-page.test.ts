import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import { recordAttempt } from "../../src/server/api/handlers.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import {
  workOrderApprovals,
  workOrderItems,
  workOrders,
} from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createApproval } from "../../src/server/taller/approvals.ts";
import { newShareToken } from "../../src/server/taller/share-tokens.ts";
import { createTestDb, type TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({ db: null as AppDb | null }));
vi.mock("../../src/server/db/client.ts", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("Base de prueba no inicializada");
    return holder.db;
  },
}));
const { default: ApprovalPage } = await import("../../src/pages/aprobacion/[token].astro");
const SITE = "https://vectorbikes.cl";
const NOW = new Date("2026-10-08T15:00:00Z");
const INPUT = {
  description: "Cadena desgastada",
  recommendation: "Reemplazar la cadena",
  priceClp: 35000,
};
let test: TestDb;
let owner: SessionUser;
let orderId: string;
let token: string;
let approvalId: string;

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
      phoneE164: "+56912345678",
      email: "ana@example.test",
      rut: "12.345.678-5",
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
      status: "diagnostico",
      requestedService: "Mantención",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta orden");
  orderId = order.id;
}

async function render(value = token, decision?: string, origin?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
  if (origin) headers.origin = origin;
  if (decision !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const request = new Request(`${SITE}/aprobacion/${value}`, {
    method: decision === undefined ? "GET" : "POST",
    headers,
    body: decision === undefined ? undefined : new URLSearchParams({ decision }),
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(ApprovalPage, { request, params: { token: value } });
}

async function invalidResponse(value: string, decision?: string) {
  const response = await render(value, decision);
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await response.text();
  expect(html).toContain("Enlace no válido");
  expect(html).toContain('name="robots" content="noindex"');
  expect(html).not.toContain(value);
  return html;
}

beforeEach(async () => {
  test = await createTestDb();
  holder.db = test.db;
  await seedOwner();
  await seedOrder();
  const result = await createApproval(test.db, owner, orderId, INPUT, NOW);
  if (!result.ok) throw new Error(result.code);
  token = result.token;
  approvalId = result.approvalId;
  return async () => {
    holder.db = null;
    await test.close();
  };
});

it("GET inexistente y ya decidido tienen el mismo status 404 y HTML byte por byte", async () => {
  const missingHtml = await invalidResponse(newShareToken());
  await test.db
    .update(workOrderApprovals)
    .set({ decidedAt: NOW, decision: "aprobado" })
    .where(eq(workOrderApprovals.id, approvalId));
  expect(await invalidResponse(token)).toBe(missingHtml);
});

it.each(["approval_voided", "order_status", "order_voided", "invalid_shape"] as const)(
  "GET %s responde el mismo 404 y HTML que un token inexistente",
  async (condition) => {
    const missingHtml = await invalidResponse(newShareToken());
    if (condition === "approval_voided")
      await test.db
        .update(workOrderApprovals)
        .set({ voidedAt: NOW })
        .where(eq(workOrderApprovals.id, approvalId));
    if (condition === "order_status")
      await test.db
        .update(workOrders)
        .set({ status: "en_reparacion" })
        .where(eq(workOrders.id, orderId));
    if (condition === "order_voided")
      await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
    expect(await invalidResponse(condition === "invalid_shape" ? "invalido" : token)).toBe(
      missingHtml,
    );
  },
);

it("GET pendiente muestra nombre y propuesta con precio, sin datos sensibles ni token", async () => {
  const response = await render();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await response.text();
  for (const text of [
    "Hola Ana",
    "Trek Marlin",
    INPUT.description,
    INPUT.recommendation,
    "$35.000",
    "Aprobar",
    "Rechazar",
  ])
    expect(html).toContain(text);
  for (const secret of ["María Pérez", "+56912345678", "ana@example.test", "12.345.678-5", token])
    expect(html).not.toContain(secret);
  expect(html.match(/<form\b/g)).toHaveLength(1);
});

it.each([
  ["aprobar", "Aprobado", undefined],
  ["rechazar", "Rechazado", "https://visor.example.test"],
] as const)(
  "POST %s confirma sin redirect ni token, con Origin ausente o externo",
  async (decision, label, origin) => {
    const response = await render(token, decision, origin);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(`Gracias, registramos tu respuesta: ${label}`);
    expect(html).not.toContain(token);
    const missingHtml = await invalidResponse(newShareToken());
    expect(await invalidResponse(token)).toBe(missingHtml);
    expect(await invalidResponse(token, decision)).toBe(missingHtml);
    expect(await invalidResponse(newShareToken(), decision)).toBe(missingHtml);
  },
);

it.each([
  "approval_voided",
  "order_voided",
  "order_status",
  "invalid_shape",
  "invalid_decision",
] as const)("POST %s colapsa en el mismo 404 sin crear líneas", async (condition) => {
  const missingHtml = await invalidResponse(newShareToken());
  if (condition === "approval_voided")
    await test.db
      .update(workOrderApprovals)
      .set({ voidedAt: NOW })
      .where(eq(workOrderApprovals.id, approvalId));
  if (condition === "order_voided")
    await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
  if (condition === "order_status")
    await test.db
      .update(workOrders)
      .set({ status: "en_reparacion" })
      .where(eq(workOrders.id, orderId));
  expect(
    await invalidResponse(
      condition === "invalid_shape" ? "invalido" : token,
      condition === "invalid_decision" ? "otro" : "aprobar",
    ),
  ).toBe(missingHtml);
  expect(await test.db.select().from(workOrderItems)).toEqual([]);
});

it("POST bloquea tras cinco intentos antes de decidir y devuelve 429 con Retry-After", async () => {
  for (let count = 0; count < 5; count++)
    await recordAttempt({ db: test.db, now: new Date(), ip: "203.0.113.7" });
  const response = await render(token, "aprobar");
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("600");
  expect(await response.text()).toContain("Demasiados intentos. Vuelve a intentar en 10 minutos.");
  expect((await test.db.select().from(workOrderApprovals))[0]?.decidedAt).toBeNull();
});
