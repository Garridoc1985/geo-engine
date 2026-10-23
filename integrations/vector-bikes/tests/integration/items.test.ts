import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
  confirmDeliveryDate,
  loadByDate,
  suggestDeliveryDate,
} from "../../src/server/taller/delivery-date.ts";
import { addCatalogItem, listItems, voidItem } from "../../src/server/taller/items.ts";
import { startReception } from "../../src/server/taller/orders.ts";
import { LOAD_EXCLUDED_STATUSES } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-05T15:00:00.000Z");
const LATER = new Date("2026-10-05T16:00:00.000Z");
let test: TestDb;
let mechanic: SessionUser;
let owner: SessionUser;
let orderId: string;
let serviceId: string;

async function createActor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      email: `${randomUUID()}@example.test`,
      name: "Personal de prueba",
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, email: user.email, name: user.name };
}

async function createOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: mechanic.branchId,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: mechanic.branchId,
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
      branchId: mechanic.branchId,
      name: "Ajuste de frenos",
      estimatedMinutes: 45,
    })
    .returning();
  if (!service) throw new Error("Falta el servicio de prueba.");
  await test.db.insert(servicePrices).values([
    { branchId: mechanic.branchId, serviceId: service.id, bikeType: "mtb", priceClp: 18000 },
    { branchId: mechanic.branchId, serviceId: service.id, bikeType: "ruta", priceClp: 24000 },
  ]);
  return service.id;
}

async function orderRow() {
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  if (!order) throw new Error("Falta la orden de prueba.");
  return order;
}

async function addLine(quantity = 1) {
  const result = await addCatalogItem(test.db, mechanic, orderId, { serviceId, quantity }, NOW);
  if (!result.ok) throw new Error("No se pudo agregar la línea de prueba.");
  return result.itemId;
}

describe("líneas y fecha de entrega en PGlite", () => {
  beforeEach(async () => {
    test = await createTestDb();
    const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
    if (!branch) throw new Error("Falta la sucursal de prueba.");
    mechanic = await createActor(branch.id, "mechanic");
    owner = await createActor(branch.id, "owner");
    orderId = await createOrder();
    serviceId = await createService();
    return () => test.close();
  });

  it("1: usa el precio MTB y la duración del catálogo, también para el mecánico", async () => {
    const itemId = await addLine(2);
    const [item] = await listItems(test.db, mechanic, orderId);
    expect(item).toMatchObject({
      id: itemId,
      branchId: mechanic.branchId,
      workOrderId: orderId,
      kind: "servicio",
      origin: "inicial",
      serviceId,
      description: "Ajuste de frenos",
      quantity: 2,
      unitPriceClp: 18000,
      estimatedMinutes: 45,
      createdBy: mechanic.id,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [audit] = await test.db.select().from(auditLog).where(eq(auditLog.action, "item.added"));
    expect(audit).toMatchObject({
      branchId: mechanic.branchId,
      actorUserId: mechanic.id,
      entityId: orderId,
      details: {
        itemId,
        kind: "servicio",
        origin: "inicial",
        serviceId,
        quantity: 2,
        unitPriceClp: 18000,
      },
    });
    expect(Object.keys(audit?.details ?? {}).sort()).toEqual(
      ["itemId", "kind", "origin", "serviceId", "quantity", "unitPriceClp"].sort(),
    );
    expect(await orderRow()).toMatchObject({ totalClp: 36000, estimatedMinutes: 90 });
  });

  it("2: agrega dos líneas, anula una y compara totales con las filas vigentes", async () => {
    const itemId = await addLine(2);
    await addLine(3);
    expect(await orderRow()).toMatchObject({ totalClp: 90000, estimatedMinutes: 225 });
    expect(await voidItem(test.db, owner, itemId, LATER)).toEqual({ ok: true });
    const rows = await test.db
      .select()
      .from(workOrderItems)
      .where(eq(workOrderItems.workOrderId, orderId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === itemId)).toMatchObject({
      voidedAt: LATER,
      voidedBy: owner.id,
      updatedAt: LATER,
    });
    const active = rows.filter((row) => row.voidedAt === null);
    const totals = active.reduce(
      (sum, row) => ({
        totalClp: sum.totalClp + row.quantity * row.unitPriceClp,
        estimatedMinutes: sum.estimatedMinutes + row.quantity * row.estimatedMinutes,
      }),
      { totalClp: 0, estimatedMinutes: 0 },
    );
    expect(await orderRow()).toMatchObject(totals);
    expect(await listItems(test.db, mechanic, orderId)).toEqual(active);
    const [audit] = await test.db.select().from(auditLog).where(eq(auditLog.action, "item.voided"));
    expect(audit?.details).toEqual({ itemId });
    const remaining = active[0];
    if (!remaining) throw new Error("Falta la línea vigente.");
    await voidItem(test.db, owner, remaining.id, LATER);
    expect(await orderRow()).toMatchObject({ totalClp: 0, estimatedMinutes: 0 });
  });

  it("3: sin precio para el tipo de bicicleta no inserta ni cambia totales o auditoría", async () => {
    const [service] = await test.db
      .insert(services)
      .values({
        branchId: mechanic.branchId,
        name: "Servicio sin precio",
        estimatedMinutes: 60,
      })
      .returning();
    if (!service) throw new Error("Falta el servicio de prueba.");
    await test.db.insert(servicePrices).values({
      branchId: mechanic.branchId,
      serviceId: service.id,
      bikeType: "ruta",
      priceClp: 5000,
    });
    const before = await orderRow();
    const audits = await test.db.select().from(auditLog);
    expect(
      await addCatalogItem(
        test.db,
        mechanic,
        orderId,
        { serviceId: service.id, quantity: 1 },
        LATER,
      ),
    ).toEqual({ ok: false, code: "no_price" });
    expect(await listItems(test.db, mechanic, orderId)).toEqual([]);
    expect(await orderRow()).toEqual(before);
    expect(await test.db.select().from(auditLog)).toEqual(audits);
  });

  it("6: confirma hoy o una fecha posterior con instante y auditoría", async () => {
    expect(await confirmDeliveryDate(test.db, mechanic, orderId, "2026-10-05", NOW)).toEqual({
      ok: true,
    });
    expect(await confirmDeliveryDate(test.db, mechanic, orderId, "2026-10-13", LATER)).toEqual({
      ok: true,
    });
    expect(await orderRow()).toMatchObject({
      estimatedDeliveryDate: "2026-10-13",
      deliveryDateConfirmedAt: LATER,
      updatedAt: LATER,
    });
    const rows = await test.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "order.delivery_date_confirmed"));
    expect(rows.map((row) => row.details)).toEqual([
      { date: "2026-10-05" },
      { date: "2026-10-13" },
    ]);
    const before = await orderRow();
    for (const date of ["2026-10-04", "2026-02-30", "texto"]) {
      expect(await confirmDeliveryDate(test.db, mechanic, orderId, date, LATER)).toEqual({
        ok: false,
        code: "invalid_date",
      });
    }
    expect(await orderRow()).toEqual(before);
  });

  it("restringe cambios y lecturas por sucursal y acceso del mecánico", async () => {
    const itemId = await addLine();
    const otherMechanic = await createActor(mechanic.branchId, "mechanic");
    const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
    if (!branch) throw new Error("Falta la otra sucursal.");
    const otherBranch = await createActor(branch.id, "owner");
    const before = await orderRow();
    for (const [actor, code] of [
      [otherMechanic, "forbidden"],
      [otherBranch, "not_found"],
    ] as const) {
      expect(await addCatalogItem(test.db, actor, orderId, { serviceId }, LATER)).toEqual({
        ok: false,
        code,
      });
      expect(await confirmDeliveryDate(test.db, actor, orderId, "2026-10-13", LATER)).toEqual({
        ok: false,
        code,
      });
      expect(await listItems(test.db, actor, orderId)).toEqual([]);
    }
    for (const actor of [mechanic, await createActor(mechanic.branchId, "reception")]) {
      expect(await voidItem(test.db, actor, itemId, LATER)).toEqual({
        ok: false,
        code: "forbidden",
      });
    }
    expect(await voidItem(test.db, otherBranch, itemId, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await orderRow()).toEqual(before);
    const admin = await createActor(mechanic.branchId, "admin");
    expect(await voidItem(test.db, admin, itemId, LATER)).toEqual({ ok: true });
  });

  it("agrupa carga por fecha, filtrando sucursal, rango, orden y estados excluidos", async () => {
    const source = await orderRow();
    const { id: _id, number: _number, ...base } = source;
    const dated = (number: number, date: string, minutes: number) => ({
      ...base,
      number,
      estimatedDeliveryDate: date,
      estimatedMinutes: minutes,
    });
    const [branch] = await test.db
      .insert(branches)
      .values({ name: "Sucursal de carga" })
      .returning();
    if (!branch) throw new Error("Falta la otra sucursal.");
    await test.db
      .update(workOrders)
      .set({ estimatedDeliveryDate: "2026-10-06", estimatedMinutes: 999 })
      .where(eq(workOrders.id, orderId));
    await test.db.insert(workOrders).values([
      dated(2, "2026-10-06", 100),
      { ...dated(3, "2026-10-06", 50), status: "en_reparacion" },
      dated(4, "2026-10-07", 90),
      dated(5, "2026-10-08", 999),
      { ...dated(1, "2026-10-06", 999), branchId: branch.id },
      ...LOAD_EXCLUDED_STATUSES.map((status, index) => ({
        ...dated(6 + index, "2026-10-06", 999),
        status,
        qcApprovedAt: NOW,
      })),
    ]);
    expect(
      await loadByDate(test.db, mechanic.branchId, "2026-10-06", "2026-10-07", orderId),
    ).toEqual(
      new Map([
        ["2026-10-06", 150],
        ["2026-10-07", 90],
      ]),
    );
  });

  it("revierte líneas, totales y fecha si falla la auditoría", async () => {
    await test.db.execute(sql`alter table audit_log add constraint test_item_audit_check
      check (action not in ('item.added', 'item.voided', 'order.delivery_date_confirmed'))`);
    const before = await orderRow();
    await expect(
      addCatalogItem(test.db, mechanic, orderId, { serviceId }, LATER),
    ).rejects.toThrow();
    expect(await listItems(test.db, mechanic, orderId)).toEqual([]);
    expect(await orderRow()).toEqual(before);
    await expect(
      confirmDeliveryDate(test.db, mechanic, orderId, "2026-10-13", LATER),
    ).rejects.toThrow();
    expect(await orderRow()).toEqual(before);
  });

  it("revierte la anulación y sus totales si falla la auditoría", async () => {
    const itemId = await addLine();
    const rows = await listItems(test.db, owner, orderId);
    const before = await orderRow();
    await test.db.execute(
      sql`alter table audit_log add constraint test_void_audit_check check (action <> 'item.voided')`,
    );
    await expect(voidItem(test.db, owner, itemId, LATER)).rejects.toThrow();
    expect(await listItems(test.db, owner, orderId)).toEqual(rows);
    expect(await orderRow()).toEqual(before);
  });
});

it.each([
  [90, 0, "2026-10-06"],
  [90, 300, "2026-10-07"],
  [90, 270, "2026-10-06"],
  [400, 30, "2026-10-07"],
])("4: orden de %i minutos y carga %i el 06 devuelve %s", (orderMinutes, load, expected) => {
  expect(
    suggestDeliveryDate({
      now: NOW,
      orderMinutes: Number(orderMinutes),
      loadByDate: new Map([["2026-10-06", Number(load)]]),
      isBusinessDay: () => true,
    }),
  ).toBe(expected);
});

it("5: calendario real omite el domingo 11 y el feriado 12 de octubre", () => {
  expect(
    suggestDeliveryDate({
      now: new Date("2026-10-10T15:00:00.000Z"),
      orderMinutes: 90,
      loadByDate: new Map(),
    }),
  ).toBe("2026-10-13");
});

it("sin cupo devuelve el último día revisado, incluso si está cerrado", () => {
  expect(
    suggestDeliveryDate({
      now: NOW,
      orderMinutes: 90,
      loadByDate: new Map(),
      horizonDays: 3,
      isBusinessDay: () => false,
    }),
  ).toBe("2026-10-08");
});
