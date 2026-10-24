import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import {
  orderPhotos,
  workOrders,
  workOrderStatusHistory,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { openWarrantyOrder } from "../../src/server/taller/orders.ts";
import { listOrderPhotos, photoKeys } from "../../src/server/taller/photos.ts";
import type { PhotoStage } from "../../src/server/taller/photos.ts";
import { orderDetail } from "../../src/server/taller/status.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
const REASON = "El cambio necesita un nuevo ajuste";
let test: TestDb;
let owner: SessionUser;
let orderId: string;

async function createOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Cliente de prueba", phoneE164: "+56912345678" })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer.id,
      brand: "Vector",
      model: "Prueba",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Revisión general",
      totalClp: 25000,
      assignedMechanicId: owner.id,
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

async function deliverOrder() {
  await test.db.execute(sql`
    update work_orders
    set status = 'entregada', qc_approved_at = ${NOW.toISOString()}, paid_clp = total_clp
    where branch_id = ${owner.branchId} and id = ${orderId}
  `);
}

async function openWarranty(reason = REASON) {
  const result = await openWarrantyOrder(test.db, owner, orderId, { reason }, NOW);
  if (!result.ok) throw new Error(`No se abrió la garantía: ${result.code}`);
  return result.orderId;
}

async function expectNoWarranty() {
  expect(await test.db.select().from(workOrders)).toHaveLength(1);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  const [branch] = await test.db.select().from(branches).where(eq(branches.id, owner.branchId));
  expect(branch?.nextOrderNumber).toBe(2);
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db
    .insert(branches)
    .values({ name: "Vitacura", nextOrderNumber: 2 })
    .returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const [user] = await test.db
    .insert(users)
    .values({
      branchId: branch.id,
      role: "owner",
      name: "Dueño de prueba",
      email: "duenio@example.test",
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  owner = { id: user.id, branchId: branch.id, role: "owner", name: user.name, email: user.email };
  orderId = await createOrder();
  return () => test.close();
});

it("1: crea una garantía reservada con el mismo cliente, bicicleta y vínculo original", async () => {
  await deliverOrder();
  const [original] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  const warrantyId = await openWarranty(`  ${REASON}  `);
  const [warranty] = await test.db.select().from(workOrders).where(eq(workOrders.id, warrantyId));
  expect(warrantyId).not.toBe(orderId);
  expect(warranty).toMatchObject({
    branchId: owner.branchId,
    number: 2,
    status: "reservada",
    customerId: original?.customerId,
    bikeId: original?.bikeId,
    warrantyOfOrderId: orderId,
    requestedService: `Garantía de OT-00001: ${REASON}`,
    createdBy: owner.id,
    assignedMechanicId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(await test.db.select().from(workOrders).where(eq(workOrders.id, orderId))).toEqual([
    original,
  ]);
  const history = await test.db
    .select()
    .from(workOrderStatusHistory)
    .where(eq(workOrderStatusHistory.workOrderId, warrantyId));
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    branchId: owner.branchId,
    fromStatus: null,
    toStatus: "reservada",
    actorUserId: owner.id,
    createdAt: NOW,
  });
});

it("2: rechaza una orden no entregada sin crear filas ni consumir un número", async () => {
  expect(await openWarrantyOrder(test.db, owner, orderId, { reason: REASON }, NOW)).toEqual({
    ok: false,
    code: "not_delivered",
  });
  await expectNoWarranty();
});

it("3: audita la apertura con solo originalNumber, sin el motivo", async () => {
  await deliverOrder();
  const warrantyId = await openWarranty();
  const audit = await test.db.select().from(auditLog);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: owner.id,
    action: "order.warranty_opened",
    entity: "work_order",
    entityId: warrantyId,
    details: { originalNumber: 1 },
    createdAt: NOW,
  });
  expect(audit[0]?.details).toEqual({ originalNumber: 1 });
  expect(JSON.stringify(audit)).not.toContain(REASON);
});

it("4: orderDetail incluye el número de la orden original de la garantía", async () => {
  await deliverOrder();
  const detail = await orderDetail(test.db, owner, await openWarranty());
  expect(detail.ok).toBe(true);
  if (!detail.ok) throw new Error("Falta el detalle de garantía.");
  expect(detail.warrantyOfNumber).toBe(1);
});

it("5: lista fotos agrupadas por las tres etapas y excluye las anuladas", async () => {
  const stages: PhotoStage[] = ["terminado", "recepcion", "reparacion", "terminado"];
  const rows = stages.map((stage, index) => {
    const id = randomUUID();
    return {
      id,
      branchId: owner.branchId,
      workOrderId: orderId,
      stage,
      retentionClass: stage === "recepcion" ? ("recepcion_6m" as const) : ("permanente" as const),
      ...photoKeys(orderId, id),
      width: 64,
      height: 48,
      createdBy: owner.id,
      voidedAt: index === 3 ? NOW : null,
      voidedBy: index === 3 ? owner.id : null,
      fullPurgedAt: stage === "recepcion" ? NOW : null,
    };
  });
  await test.db.insert(orderPhotos).values(rows);
  const photos = await listOrderPhotos(test.db, owner, orderId);
  expect(photos.map((photo) => photo.stage)).toEqual(["recepcion", "reparacion", "terminado"]);
  expect(photos.map((photo) => photo.id)).not.toContain(rows[3]?.id);
  expect(photos[0]?.fullUrl).toBeNull();
  expect(photos[0]?.thumbUrl).toBe(`/taller/media/${rows[1]?.thumbKey}`);
  expect(await test.db.select().from(orderPhotos)).toHaveLength(4);
});

it("rechaza al mecánico antes de validar el motivo", async () => {
  await deliverOrder();
  expect(
    await openWarrantyOrder(test.db, { ...owner, role: "mechanic" }, orderId, { reason: "" }, NOW),
  ).toEqual({ ok: false, code: "forbidden" });
  await expectNoWarranty();
});

it("no encuentra una orden fuera de la sucursal del actor", async () => {
  await deliverOrder();
  const foreign = { ...owner, branchId: randomUUID() };
  expect(await openWarrantyOrder(test.db, foreign, orderId, { reason: REASON }, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  await expectNoWarranty();
});

it("no abre garantías de órdenes anuladas o inexistentes", async () => {
  await deliverOrder();
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
  for (const id of [orderId, randomUUID()]) {
    expect(await openWarrantyOrder(test.db, owner, id, { reason: REASON }, NOW)).toEqual({
      ok: false,
      code: "not_found",
    });
  }
  await expectNoWarranty();
});

it.each(["   ", " ab ", "a".repeat(301)])("rechaza un motivo inválido: %j", async (reason) => {
  await deliverOrder();
  expect(await openWarrantyOrder(test.db, owner, orderId, { reason }, NOW)).toEqual({
    ok: false,
    code: "validation_error",
  });
  await expectNoWarranty();
});
