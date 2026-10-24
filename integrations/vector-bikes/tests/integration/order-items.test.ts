import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { workOrderItems, workOrders } from "../../src/server/db/schema-orders.ts";
import {
  auditLog,
  bikes,
  customers,
  servicePrices,
  services,
} from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  addCatalogItem,
  addPartItem,
  listItems,
  overrideItemPrice,
  voidItem,
} from "../../src/server/taller/items.ts";
import { startReception, updateTaxDocument } from "../../src/server/taller/orders.ts";
import { TERMINAL_STATUSES } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-07T15:00:00.000Z");
const LATER = new Date("2026-10-07T16:00:00.000Z");
const PART = { description: "Cadena de repuesto", quantity: 2, unitPriceClp: 15000 };
const FORBIDDEN = { ok: false, code: "forbidden" };
const INVALID_INPUT = { ok: false, code: "validation_error" };
const INVALID_STATUS = { ok: false, code: "invalid_status" };
const TAX = { type: "factura", number: "F-123", date: "2026-10-07" };
let test: TestDb;
let owner: SessionUser;
let admin: SessionUser;
let reception: SessionUser;
let mechanic: SessionUser;
let orderId: string;
let serviceId: string;

async function actor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: "Personal de prueba",
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function createOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: owner.branchId,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer.id,
      brand: "Specialized",
      model: "Rockhopper",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const result = await startReception(
    test.db,
    mechanic,
    {
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Revisión general",
    },
    NOW,
  );
  if (!result.ok) throw new Error("Falta la orden de prueba.");
  return result.orderId;
}

async function createService() {
  const [service] = await test.db
    .insert(services)
    .values({
      branchId: owner.branchId,
      name: "Ajuste de frenos",
      estimatedMinutes: 45,
    })
    .returning();
  if (!service) throw new Error("Falta el servicio de prueba.");
  await test.db.insert(servicePrices).values([
    { branchId: owner.branchId, serviceId: service.id, bikeType: "mtb", priceClp: 18000 },
    { branchId: owner.branchId, serviceId: service.id, bikeType: "ruta", priceClp: 24000 },
  ]);
  return service.id;
}

async function addLine() {
  const result = await addCatalogItem(test.db, mechanic, orderId, { serviceId, quantity: 2 }, NOW);
  if (!result.ok) throw new Error("Falta la línea de prueba.");
  return result.itemId;
}

async function snapshot() {
  return {
    orders: await test.db.select().from(workOrders),
    items: await test.db.select().from(workOrderItems),
    audits: await test.db.select().from(auditLog),
  };
}

async function orderRow() {
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  if (!order) throw new Error("Falta la orden de prueba.");
  return order;
}

async function audits(action: string) {
  return test.db.select().from(auditLog).where(eq(auditLog.action, action));
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await actor(branch.id, "owner");
  admin = await actor(branch.id, "admin");
  reception = await actor(branch.id, "reception");
  mechanic = await actor(branch.id, "mechanic");
  orderId = await createOrder();
  serviceId = await createService();
  return () => test.close();
});

it("1: el mecánico no cambia precios ni agrega repuestos, sin cambiar ninguna fila", async () => {
  const itemId = await addLine();
  const before = await snapshot();
  expect(
    await overrideItemPrice(test.db, mechanic, itemId, { unitPriceClp: 20000 }, LATER),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await addPartItem(test.db, mechanic, orderId, PART, LATER)).toEqual(FORBIDDEN);
  // El permiso precede incluso a la validación o búsqueda de una fila inexistente.
  expect(await overrideItemPrice(test.db, mechanic, randomUUID(), null, LATER)).toEqual(FORBIDDEN);
  expect(await addPartItem(test.db, mechanic, randomUUID(), null, LATER)).toEqual(FORBIDDEN);
  expect(await snapshot()).toEqual(before);
});

it.each(["owner", "admin"] as const)(
  "2: %s cambia el precio, recalcula y audita before/after",
  async (role) => {
    const staff = role === "owner" ? owner : admin;
    const itemId = await addLine();
    expect(await overrideItemPrice(test.db, staff, itemId, { unitPriceClp: 21000 }, LATER)).toEqual(
      { ok: true },
    );
    expect((await listItems(test.db, staff, orderId))[0]).toMatchObject({
      id: itemId,
      unitPriceClp: 21000,
      updatedAt: LATER,
    });
    expect(await orderRow()).toMatchObject({
      totalClp: 42000,
      estimatedMinutes: 90,
      updatedAt: LATER,
    });
    const rows = await audits("item.price_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: staff.id,
      branchId: staff.branchId,
      entityId: orderId,
      details: { itemId, before: 18000, after: 21000 },
      createdAt: LATER,
    });
    expect(rows[0]?.details).toEqual({ itemId, before: 18000, after: 21000 });
  },
);

it("3: anula sin borrar y excluye la línea de los totales", async () => {
  const itemId = await addLine();
  await addPartItem(test.db, owner, orderId, PART, NOW);
  expect(await voidItem(test.db, owner, itemId, LATER)).toEqual({ ok: true });
  const [item] = await test.db.select().from(workOrderItems).where(eq(workOrderItems.id, itemId));
  expect(item).toMatchObject({ id: itemId, voidedAt: LATER, voidedBy: owner.id, updatedAt: LATER });
  expect(await orderRow()).toMatchObject({ totalClp: 30000, estimatedMinutes: 0 });
  expect((await listItems(test.db, owner, orderId)).map((row) => row.id)).not.toContain(itemId);
  expect((await audits("item.voided"))[0]?.details).toEqual({ itemId });
});

it("4: agrega un repuesto inicial y suma cantidad por precio al total", async () => {
  await addLine();
  const result = await addPartItem(test.db, reception, orderId, PART, LATER);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("No se agregó el repuesto.");
  const [item] = await test.db
    .select()
    .from(workOrderItems)
    .where(eq(workOrderItems.id, result.itemId));
  expect(item).toMatchObject({
    ...PART,
    branchId: reception.branchId,
    workOrderId: orderId,
    kind: "repuesto",
    origin: "inicial",
    serviceId: null,
    estimatedMinutes: 0,
    createdBy: reception.id,
    createdAt: LATER,
    updatedAt: LATER,
  });
  expect(await orderRow()).toMatchObject({ totalClp: 66000, estimatedMinutes: 90 });
});

it.each(["boleta", "factura"] as const)(
  "5: guarda %s, folio y fecha, y audita el documento",
  async (type) => {
    const input = { ...TAX, type };
    expect(await updateTaxDocument(test.db, reception, orderId, input, LATER)).toEqual({
      ok: true,
    });
    expect(await orderRow()).toMatchObject({
      taxDocType: type,
      taxDocNumber: TAX.number,
      taxDocDate: TAX.date,
      updatedAt: LATER,
    });
    const rows = await audits("order.tax_document");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      branchId: reception.branchId,
      actorUserId: reception.id,
      entityId: orderId,
      createdAt: LATER,
    });
    expect(rows[0]?.details).toEqual(input);
  },
);

it.each(TERMINAL_STATUSES)(
  "rechaza todas las ediciones de líneas en %s sin cambios",
  async (status) => {
    const itemId = await addLine();
    const order = await orderRow();
    await test.db
      .update(workOrders)
      .set({ status, paidClp: order.totalClp, qcApprovedAt: NOW })
      .where(eq(workOrders.id, orderId));
    const before = await snapshot();
    expect(await addCatalogItem(test.db, owner, orderId, { serviceId }, LATER)).toEqual(
      INVALID_STATUS,
    );
    expect(await addPartItem(test.db, owner, orderId, PART, LATER)).toEqual(INVALID_STATUS);
    expect(await overrideItemPrice(test.db, owner, itemId, { unitPriceClp: 0 }, LATER)).toEqual(
      INVALID_STATUS,
    );
    expect(await voidItem(test.db, owner, itemId, LATER)).toEqual(INVALID_STATUS);
    expect(await snapshot()).toEqual(before);
  },
);

it("item.added de repuesto solo guarda metadatos, nunca la descripción", async () => {
  const description = "Cadena para Ana ana@example.cl +56912345678";
  const result = await addPartItem(test.db, owner, orderId, { ...PART, description }, LATER);
  if (!result.ok) throw new Error("No se agregó el repuesto.");
  const rows = await audits("item.added");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.details).toEqual({
    itemId: result.itemId,
    kind: "repuesto",
    origin: "inicial",
    quantity: 2,
    unitPriceClp: 15000,
  });
  expect(JSON.stringify(rows[0]?.details)).not.toContain("Cadena");
  expect(JSON.stringify(rows[0]?.details)).not.toContain("Ana");
  expect(JSON.stringify(rows[0]?.details)).not.toContain("ana@example.cl");
});

it("cambiar el precio de una línea anulada devuelve not_found sin cambios", async () => {
  const itemId = await addLine();
  await voidItem(test.db, owner, itemId, NOW);
  await test.db.update(workOrders).set({ status: "cancelada" }).where(eq(workOrders.id, orderId));
  const before = await snapshot();
  expect(await overrideItemPrice(test.db, owner, itemId, { unitPriceClp: 25000 }, LATER)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await snapshot()).toEqual(before);
});

it("valida montos enteros y límites antes de cambiar filas", async () => {
  const itemId = await addLine();
  const before = await snapshot();
  for (const unitPriceClp of [-1, 10000001, 1.5, "", null, true]) {
    expect(await addPartItem(test.db, owner, orderId, { ...PART, unitPriceClp }, LATER)).toEqual(
      INVALID_INPUT,
    );
    expect(await overrideItemPrice(test.db, owner, itemId, { unitPriceClp }, LATER)).toEqual(
      INVALID_INPUT,
    );
  }
  for (const input of [
    { ...PART, quantity: 0 },
    { ...PART, quantity: 101 },
    { ...PART, quantity: 1.5 },
    { ...PART, description: "x" },
    { ...PART, description: "x".repeat(201) },
  ]) {
    expect(await addPartItem(test.db, owner, orderId, input, LATER)).toEqual(INVALID_INPUT);
  }
  expect(await snapshot()).toEqual(before);
  expect(await overrideItemPrice(test.db, owner, itemId, { unitPriceClp: "0" }, LATER)).toEqual({
    ok: true,
  });
  expect(await orderRow()).toMatchObject({ totalClp: 0 });
  expect(
    (
      await addPartItem(
        test.db,
        owner,
        orderId,
        { ...PART, quantity: 1, unitPriceClp: 10000000 },
        LATER,
      )
    ).ok,
  ).toBe(true);
});

it("protege permisos del documento y del precio para recepción", async () => {
  const itemId = await addLine();
  const before = await snapshot();
  expect(await overrideItemPrice(test.db, reception, itemId, { unitPriceClp: 0 }, LATER)).toEqual(
    FORBIDDEN,
  );
  expect(await updateTaxDocument(test.db, mechanic, randomUUID(), null, LATER)).toEqual(FORBIDDEN);
  for (const input of [
    { ...TAX, type: "otro" },
    { ...TAX, number: "" },
    { ...TAX, number: "x".repeat(31) },
    { ...TAX, date: "2026-02-30" },
    { ...TAX, date: "07/10/2026" },
  ]) {
    expect(await updateTaxDocument(test.db, owner, orderId, input, LATER)).toEqual(INVALID_INPUT);
  }
  expect(await snapshot()).toEqual(before);
});

it("no modifica líneas ni documentos de otra sucursal o de órdenes anuladas", async () => {
  const itemId = await addLine();
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const outsider = await actor(branch.id, "owner");
  for (const staff of [outsider, owner]) {
    if (staff === owner)
      await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
    const before = await snapshot();
    expect(await addPartItem(test.db, staff, orderId, PART, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await overrideItemPrice(test.db, staff, itemId, { unitPriceClp: 0 }, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await updateTaxDocument(test.db, staff, orderId, TAX, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await snapshot()).toEqual(before);
  }
});

it("revierte línea, precio, totales y documento si falla la auditoría", async () => {
  const itemId = await addLine();
  const before = await snapshot();
  await test.client.exec(`
    create function reject_item_audit() returns trigger language plpgsql as $$
    begin raise exception 'Auditoría no disponible'; end; $$;
    create trigger reject_item_audit before insert on audit_log
    for each row execute function reject_item_audit();
  `);
  await expect(addPartItem(test.db, owner, orderId, PART, LATER)).rejects.toThrow();
  await expect(
    overrideItemPrice(test.db, owner, itemId, { unitPriceClp: 5000 }, LATER),
  ).rejects.toThrow();
  await expect(updateTaxDocument(test.db, owner, orderId, TAX, LATER)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
