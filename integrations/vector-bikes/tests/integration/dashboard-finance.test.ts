import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { payments, workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { adminDashboard } from "../../src/server/taller/dashboard.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
let test: TestDb;
let staff: Record<"owner" | "admin" | "reception", SessionUser>;
let orderId: string;

async function user(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [row] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: `${role} de prueba`,
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
    })
    .returning();
  if (!row) throw new Error("Falta el usuario.");
  return { id: row.id, branchId, role, name: row.name, email: row.email };
}

async function seedReadyOrderWithDeposit(owner: SessionUser) {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Ana Pérez", phoneE164: "+56912345678" })
    .returning();
  if (!customer) throw new Error("Falta el cliente.");
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
  if (!bike) throw new Error("Falta la bicicleta.");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      status: "lista_para_retirar",
      requestedService: "Mantención general",
      createdBy: owner.id,
      qcApprovedAt: NOW,
      qcApprovedBy: owner.id,
      totalClp: 30000,
      paidClp: 10000,
    })
    .returning();
  if (!order) throw new Error("Falta la orden.");
  await test.db.insert(payments).values({
    branchId: owner.branchId,
    workOrderId: order.id,
    kind: "abono",
    method: "transferencia",
    amountClp: 10000,
    receivedBy: owner.id,
    receivedAt: NOW,
  });
  return order.id;
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal.");
  staff = {
    owner: await user(branch.id, "owner"),
    admin: await user(branch.id, "admin"),
    reception: await user(branch.id, "reception"),
  };
  orderId = await seedReadyOrderWithDeposit(staff.owner);
});

afterEach(async () => {
  await test?.close();
});

it.each(["owner", "admin"] as const)("%s ve ingresos de hoy y pagos pendientes", async (role) => {
  const dashboard = await adminDashboard(test.db, staff[role], NOW);
  expect(dashboard?.incomeTodayClp).toBe(10000);
  expect(dashboard?.pendingPayments?.map(({ id, balance }) => ({ id, balance }))).toEqual([
    { id: orderId, balance: 20000 },
  ]);
});

it("recepción no recibe ingresos ni pagos pendientes, pero sí el resto del panel", async () => {
  const dashboard = await adminDashboard(test.db, staff.reception, NOW);
  expect(dashboard?.incomeTodayClp).toBeNull();
  expect(dashboard?.pendingPayments).toBeNull();
  expect(dashboard?.readyForPickup.map(({ id }) => id)).toEqual([orderId]);
});
