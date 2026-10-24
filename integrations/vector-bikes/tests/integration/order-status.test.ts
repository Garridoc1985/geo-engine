import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { workOrders, workOrderStatusHistory } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import type { OrderStatus } from "../../src/server/taller/rules.ts";
import { ORDER_STATUSES, MANUAL_TRANSITIONS } from "../../src/server/taller/rules.ts";
import {
  assignMechanic,
  canAccessOrder,
  changeOrderStatus,
  listMechanics,
  listOrders,
  orderDetail,
  takeOrder,
  updateOrderNotes,
} from "../../src/server/taller/status.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-07T15:00:00.000Z");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let otherMechanic: SessionUser;
let orderId: string;
let number = 0;

async function actor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: `Personal ${role}`,
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function createOrder(
  status: OrderStatus = "recibida",
  assignedMechanicId: string | null = mechanic.id,
  branchId = owner.branchId,
) {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
      email: `${randomUUID()}@example.test`,
      rut: `${10000000 + number}-K`,
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId,
      customerId: customer.id,
      brand: "Specialized",
      model: "Rockhopper",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId,
      number: ++number,
      customerId: customer.id,
      bikeId: bike.id,
      status,
      requestedService: "Revisión general",
      assignedMechanicId,
      createdBy: owner.id,
      qcApprovedAt: NOW,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

async function orderRow(id = orderId) {
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, id));
  if (!order) throw new Error("Falta la orden de prueba.");
  return order;
}

async function audits(action: string) {
  return test.db.select().from(auditLog).where(eq(auditLog.action, action));
}

beforeEach(async () => {
  test = await createTestDb();
  number = 0;
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await actor(branch.id, "owner");
  mechanic = await actor(branch.id, "mechanic");
  otherMechanic = await actor(branch.id, "mechanic");
  orderId = await createOrder();
  return () => test.close();
});

it("1: rechaza recibida → lista_para_retirar sin cambiar orden, historial ni auditoría", async () => {
  const before = await orderRow();
  expect(
    await changeOrderStatus(test.db, mechanic, orderId, "lista_para_retirar", null, NOW),
  ).toEqual({ ok: false, code: "invalid_transition" });
  expect(await orderRow()).toEqual(before);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await audits("order.status_changed")).toEqual([]);
});

it("2: guarda transición manual con autor y nota, y audita la nota redactada", async () => {
  const note = "Revisar con ana@example.cl al +56 9 1234 5678";
  expect(await changeOrderStatus(test.db, mechanic, orderId, "diagnostico", note, NOW)).toEqual({
    ok: true,
  });
  expect(await orderRow()).toMatchObject({ status: "diagnostico", updatedAt: NOW });
  const history = await test.db.select().from(workOrderStatusHistory);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    fromStatus: "recibida",
    toStatus: "diagnostico",
    actorUserId: mechanic.id,
    note,
    createdAt: NOW,
  });
  const rows = await audits("order.status_changed");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: mechanic.id,
    entityId: orderId,
    details: {
      from: "recibida",
      to: "diagnostico",
      note: "Revisar con [redactado] al [redactado]",
    },
  });
  const detail = await orderDetail(test.db, mechanic, orderId);
  expect(detail.ok && detail.history[0]?.authorName).toBe(mechanic.name);
});

it("3: el mecánico no abre ni cambia una orden asignada a otro", async () => {
  expect(await orderDetail(test.db, otherMechanic, orderId)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(
    await changeOrderStatus(test.db, otherMechanic, orderId, "diagnostico", null, NOW),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await updateOrderNotes(test.db, otherMechanic, orderId, { notes: "Texto" }, NOW)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await orderRow()).toMatchObject({ status: "recibida", notes: null });
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it.each(["recibida", "diagnostico"] as const)(
  "4: toma una orden sin asignar en %s y audita mechanicId",
  async (status) => {
    const id = await createOrder(status, null);
    expect(await takeOrder(test.db, mechanic, id, NOW)).toEqual({ ok: true });
    expect(await orderRow(id)).toMatchObject({ assignedMechanicId: mechanic.id, updatedAt: NOW });
    const rows = await audits("order.assigned");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: mechanic.id,
      entityId: id,
      details: { mechanicId: mechanic.id },
    });
  },
);

it("5: lista solo sus órdenes y las sin asignar en los tres estados iniciales", async () => {
  const expected = [orderId];
  for (const status of ORDER_STATUSES) {
    const id = await createOrder(status, null);
    if (["reservada", "recibida", "diagnostico"].includes(status)) expected.push(id);
  }
  const assignedAdvanced = await createOrder("en_reparacion");
  expected.push(assignedAdvanced);
  await createOrder("recibida", otherMechanic.id);
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la otra sucursal.");
  await createOrder("recibida", null, branch.id);
  const rows = await listOrders(test.db, mechanic, { scope: "open" });
  expect(rows.map(({ order }) => order.id).sort()).toEqual(expected.sort());
  expect(rows.every(({ order }) => canAccessOrder(mechanic, order))).toBe(true);
  expect(
    (await listOrders(test.db, mechanic, { scope: "mine" })).map(({ order }) => order.id).sort(),
  ).toEqual([orderId, assignedAdvanced].sort());
});

it("omite contacto al mecánico y lo entrega al personal con customers.manage", async () => {
  const restricted = await orderDetail(test.db, mechanic, orderId);
  const full = await orderDetail(test.db, owner, orderId);
  expect(restricted.ok && Object.keys(restricted.customer).sort()).toEqual(["id", "name"]);
  expect(full.ok && full.customer).toMatchObject({
    phoneE164: "+56912345678",
    rut: "10000000-K",
  });
  const original = await createOrder("entregada");
  await test.db
    .update(workOrders)
    .set({ warrantyOfOrderId: original })
    .where(eq(workOrders.id, orderId));
  const warranty = await orderDetail(test.db, mechanic, orderId);
  expect(warranty.ok && warranty.warrantyOfNumber).toBe((await orderRow(original)).number);
});

it("asigna únicamente mecánicos activos de la sucursal y solo con orders.assign", async () => {
  expect(await assignMechanic(test.db, mechanic, orderId, otherMechanic.id, NOW)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await assignMechanic(test.db, owner, orderId, owner.id, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await assignMechanic(test.db, owner, orderId, otherMechanic.id, NOW)).toEqual({
    ok: true,
  });
  expect(await orderRow()).toMatchObject({ assignedMechanicId: otherMechanic.id });
  expect((await audits("order.assigned"))[0]?.details).toEqual({ mechanicId: otherMechanic.id });
  await test.db.update(users).set({ isActive: false }).where(eq(users.id, otherMechanic.id));
  expect(await assignMechanic(test.db, owner, orderId, otherMechanic.id, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await listMechanics(test.db, owner)).toEqual([{ id: mechanic.id, name: mechanic.name }]);
  expect(await listMechanics(test.db, mechanic)).toEqual([]);
  expect(await assignMechanic(test.db, owner, orderId, null, NOW)).toEqual({ ok: true });
});

it("no permite tomar una reservada, asignada o avanzada, ni tomar como dueño", async () => {
  expect(await takeOrder(test.db, owner, orderId, NOW)).toEqual({ ok: false, code: "forbidden" });
  for (const [status, assigned, code] of [
    ["reservada", null, "invalid_status"],
    ["recibida", mechanic.id, "invalid_status"],
    ["recibida", otherMechanic.id, "forbidden"],
    ["en_reparacion", null, "forbidden"],
  ] as const) {
    const id = await createOrder(status, assigned);
    expect(await takeOrder(test.db, mechanic, id, NOW)).toEqual({ ok: false, code });
    expect(await orderRow(id)).toMatchObject({ assignedMechanicId: assigned, status });
  }
  expect(await audits("order.assigned")).toEqual([]);
});

it("cancelar y rechazar trabajo requieren orders.cancel; audita note null", async () => {
  for (const to of ["cancelada", "trabajo_rechazado"] as const) {
    expect(await changeOrderStatus(test.db, mechanic, orderId, to, null, NOW)).toEqual({
      ok: false,
      code: "forbidden",
    });
  }
  expect(await changeOrderStatus(test.db, owner, orderId, "cancelada", null, NOW)).toEqual({
    ok: true,
  });
  expect((await audits("order.status_changed"))[0]?.details).toEqual({
    from: "recibida",
    to: "cancelada",
    note: null,
  });
});

it("actualiza textos pero la auditoría guarda exclusivamente campos realmente cambiados", async () => {
  const input = {
    diagnosis: "Contactar ana@example.cl",
    observations: "Llamar +56912345678",
    notes: "RUT 12.345.678-K",
  };
  expect(await updateOrderNotes(test.db, mechanic, orderId, input, NOW)).toEqual({ ok: true });
  expect(await orderRow()).toMatchObject(input);
  expect((await audits("order.updated"))[0]?.details).toEqual({
    fields: ["diagnosis", "observations", "notes"],
  });
  await updateOrderNotes(test.db, mechanic, orderId, input, NOW);
  expect(await audits("order.updated")).toHaveLength(1);
  await updateOrderNotes(test.db, mechanic, orderId, { notes: null }, NOW);
  expect((await audits("order.updated"))[1]?.details).toEqual({ fields: ["notes"] });
});

it("filtra lecturas y escrituras por sucursal sin cambiar filas", async () => {
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la otra sucursal.");
  const outsider = await actor(branch.id, "owner");
  const foreignMechanic = await actor(branch.id, "mechanic");
  const before = await orderRow();
  expect(await orderDetail(test.db, outsider, orderId)).toEqual({ ok: false, code: "not_found" });
  expect(await listOrders(test.db, outsider, { scope: "all" })).toEqual([]);
  expect(await changeOrderStatus(test.db, outsider, orderId, "diagnostico", null, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await updateOrderNotes(test.db, outsider, orderId, { notes: "Texto" }, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await assignMechanic(test.db, outsider, orderId, foreignMechanic.id, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await assignMechanic(test.db, owner, orderId, foreignMechanic.id, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await takeOrder(test.db, foreignMechanic, orderId, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await orderRow()).toEqual(before);
});

it("valida el estado actual bajo lock y rechaza repetir una transición", async () => {
  expect(await changeOrderStatus(test.db, mechanic, orderId, "diagnostico", null, NOW)).toEqual({
    ok: true,
  });
  expect(await changeOrderStatus(test.db, mechanic, orderId, "diagnostico", null, NOW)).toEqual({
    ok: false,
    code: "invalid_transition",
  });
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(1);
  expect(await audits("order.status_changed")).toHaveLength(1);
});

it("revierte estado, historial, asignación y notas si falla la auditoría", async () => {
  const before = await orderRow();
  await test.db.execute(
    sql`alter table audit_log add constraint test_status_audit_check check (action not in ('order.status_changed', 'order.assigned', 'order.updated'))`,
  );
  await expect(
    changeOrderStatus(test.db, mechanic, orderId, "diagnostico", null, NOW),
  ).rejects.toThrow();
  await expect(assignMechanic(test.db, owner, orderId, otherMechanic.id, NOW)).rejects.toThrow();
  await expect(
    updateOrderNotes(test.db, mechanic, orderId, { notes: "Texto" }, NOW),
  ).rejects.toThrow();
  expect(await orderRow()).toEqual(before);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  const unassigned = await createOrder("recibida", null);
  await expect(takeOrder(test.db, mechanic, unassigned, NOW)).rejects.toThrow();
  expect(await orderRow(unassigned)).toMatchObject({ assignedMechanicId: null });
});

it("rechaza todas las transiciones fuera de MANUAL_TRANSITIONS", async () => {
  for (const from of ORDER_STATUSES) {
    const id = await createOrder(from);
    const before = await orderRow(id);
    for (const to of ORDER_STATUSES) {
      if ((MANUAL_TRANSITIONS[from] as readonly string[]).includes(to)) continue;
      expect(await changeOrderStatus(test.db, owner, id, to, null, NOW)).toEqual({
        ok: false,
        code: "invalid_transition",
      });
    }
    expect(await orderRow(id)).toEqual(before);
  }
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});
