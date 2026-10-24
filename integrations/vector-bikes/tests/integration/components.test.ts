import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { bikeComponents, workOrderItems, workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  componentFormSchema,
  installComponent,
  listComponentsOfBike,
  voidComponent,
} from "../../src/server/taller/components.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T01:00:00.000Z");
const LATER = new Date("2026-10-08T15:00:00.000Z");
const INPUT = { componentType: "Cadena", brand: "Shimano", model: "CN-M6100" };
const FORBIDDEN = failure("forbidden");
const INVALID_REPLACEMENT = failure("invalid_replacement");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let order: typeof workOrders.$inferSelect;
let orderNumber: number;

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

async function createOrder(staff = owner, sameBike?: typeof order) {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: staff.branchId,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = sameBike
    ? []
    : await test.db
        .insert(bikes)
        .values({
          branchId: staff.branchId,
          customerId: customer.id,
          brand: "Specialized",
          model: "Rockhopper",
          bikeType: "mtb",
        })
        .returning();
  const [row] = await test.db
    .insert(workOrders)
    .values({
      branchId: staff.branchId,
      number: ++orderNumber,
      customerId: sameBike?.customerId ?? customer.id,
      bikeId: sameBike?.bikeId ?? bike?.id ?? "",
      status: "recibida",
      requestedService: "Revisión general",
      createdBy: staff.id,
    })
    .returning();
  if (!row) throw new Error("Falta la orden de prueba.");
  return row;
}

async function createItem(overrides: Partial<typeof workOrderItems.$inferInsert> = {}) {
  const [item] = await test.db
    .insert(workOrderItems)
    .values({
      branchId: owner.branchId,
      workOrderId: order.id,
      kind: "repuesto",
      origin: "inicial",
      description: "Cadena nueva",
      unitPriceClp: 25000,
      quantity: 2,
      createdBy: owner.id,
      ...overrides,
    })
    .returning();
  if (!item) throw new Error("Falta la línea de prueba.");
  return item.id;
}
function failure(code: string) {
  return { ok: false, code };
}
function attempt(input: unknown, now = NOW, staff = owner, orderId = order.id) {
  return installComponent(test.db, staff, orderId, input, now);
}

async function install(input: unknown = INPUT, target = order, now = NOW) {
  const result = await attempt(input, now, owner, target.id);
  if (!result.ok) throw new Error(`No se instaló el componente: ${result.code}`);
  return result.id;
}

async function componentRow(id: string) {
  const [row] = await test.db.select().from(bikeComponents).where(eq(bikeComponents.id, id));
  if (!row) throw new Error("Falta el componente de prueba.");
  return row;
}

async function snapshot() {
  return {
    components: await test.db.select().from(bikeComponents),
    orders: await test.db.select().from(workOrders),
    items: await test.db.select().from(workOrderItems),
    audits: await test.db.select().from(auditLog),
  };
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await actor(branch.id, "owner");
  mechanic = await actor(branch.id, "mechanic");
  orderNumber = 0;
  order = await createOrder();
  return () => test.close();
});
it("1: guarda los datos, la bicicleta y el precio unitario del repuesto, con auditoría", async () => {
  const workOrderItemId = await createItem();
  const input = { ...INPUT, serialNumber: " SN-123 ", installedAt: "2026-10-06", workOrderItemId };
  const result = await attempt(input, NOW, mechanic);
  if (!result.ok) throw new Error("Falta el componente instalado.");
  expect(await componentRow(result.id)).toMatchObject({
    ...INPUT,
    serialNumber: "SN-123",
    installedAt: "2026-10-06",
    workOrderItemId,
    branchId: owner.branchId,
    bikeId: order.bikeId,
    workOrderId: order.id,
    priceClp: 25000,
    createdBy: mechanic.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const [audit] = await test.db.select().from(auditLog);
  expect(audit).toMatchObject({
    branchId: owner.branchId,
    actorUserId: mechanic.id,
    action: "component.installed",
    entity: "bike_component",
    entityId: result.id,
    details: { orderId: order.id },
    createdAt: NOW,
  });
});
it("2: reemplaza desde otra visita sin borrar el anterior", async () => {
  const previousId = await install();
  const nextOrder = await createOrder(owner, order);
  const id = await install({ ...INPUT, replacesComponentId: previousId }, nextOrder, LATER);
  expect(await componentRow(previousId)).toMatchObject({
    replacedAt: "2026-10-08",
    replacedByComponentId: id,
    voidedAt: null,
    updatedAt: LATER,
  });
  expect(await componentRow(id)).toMatchObject({
    workOrderId: nextOrder.id,
    replacedAt: null,
  });
  const audits = await test.db.select().from(auditLog);
  expect(audits[1]?.details).toEqual({ orderId: nextOrder.id, replacesComponentId: previousId });
  expect(await test.db.select().from(bikeComponents)).toHaveLength(2);
});
it.each(["owner", "admin"] as const)(
  "3: %s anula sin borrar ni deshacer el reemplazo",
  async (role) => {
    const staff = role === "owner" ? owner : await actor(owner.branchId, role);
    const previousId = await install();
    const id = await install({ ...INPUT, replacesComponentId: previousId }, order, LATER);
    expect(await voidComponent(test.db, staff, id, LATER)).toEqual({ ok: true });
    expect(await componentRow(id)).toMatchObject({
      voidedAt: LATER,
      voidedBy: staff.id,
      updatedAt: LATER,
    });
    expect(await componentRow(previousId)).toMatchObject({
      replacedAt: "2026-10-08",
      replacedByComponentId: id,
    });
    const [audit] = await test.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "component.voided"));
    expect(audit).toMatchObject({
      actorUserId: staff.id,
      entity: "bike_component",
      entityId: id,
      createdAt: LATER,
    });
    expect(audit?.details).toEqual({ orderId: order.id });
    const before = await snapshot();
    expect(await voidComponent(test.db, staff, id, LATER)).toEqual(failure("already_voided"));
    expect(await snapshot()).toEqual(before);
  },
);
it("4: lista vigentes y reemplazados por fecha y creación, excluyendo anulados", async () => {
  const previousId = await install();
  const id = await install({ ...INPUT, replacesComponentId: previousId }, order, LATER);
  const sameDay = await install({ ...INPUT, installedAt: "2026-10-08" });
  const voidedId = await install();
  await voidComponent(test.db, owner, voidedId, LATER);
  const rows = await listComponentsOfBike(test.db, owner, order.bikeId);
  expect(rows.map((row) => row.id)).toEqual([id, sameDay, previousId]);
  expect(rows[2]).toMatchObject({
    replacedAt: "2026-10-08",
    replacedByComponentId: id,
  });
});
it("5: rechaza líneas de servicio, otras órdenes, anuladas, otra sucursal e inexistentes", async () => {
  const otherOrder = await createOrder();
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const ids = [
    await createItem({ kind: "servicio" }),
    await createItem({ workOrderId: otherOrder.id }),
    await createItem({ voidedAt: NOW }),
    await createItem({ branchId: branch.id }),
    randomUUID(),
  ];
  const before = await snapshot();
  for (const workOrderItemId of ids)
    expect(await attempt({ ...INPUT, workOrderItemId })).toEqual(failure("invalid_item"));
  expect(await snapshot()).toEqual(before);
});
it("sin línea guarda precio cero y aplica el día local desde now", async () => {
  const id = await install();
  expect(await componentRow(id)).toMatchObject({
    priceClp: 0,
    installedAt: "2026-10-07",
    serialNumber: null,
    workOrderItemId: null,
  });
  const before = await snapshot();
  expect(await attempt({ ...INPUT, priceClp: 1 }, NOW, mechanic)).toEqual(
    failure("validation_error"),
  );
  expect(await snapshot()).toEqual(before);
});
it("mecánico y recepción no anulan, incluso con un id inexistente, sin cambios", async () => {
  const id = await install();
  const reception = await actor(owner.branchId, "reception");
  const before = await snapshot();
  for (const staff of [mechanic, reception]) {
    expect(await voidComponent(test.db, staff, id, NOW)).toEqual(FORBIDDEN);
    expect(await voidComponent(test.db, staff, randomUUID(), NOW)).toEqual(FORBIDDEN);
  }
  expect(await snapshot()).toEqual(before);
});
it("rechaza reemplazar otra bicicleta, uno ya reemplazado, anulado o inexistente", async () => {
  const otherBikeId = await install(INPUT, await createOrder());
  const replacedId = await install();
  await attempt({ ...INPUT, replacesComponentId: replacedId }, LATER);
  const voidedId = await install();
  await voidComponent(test.db, owner, voidedId, NOW);
  const before = await snapshot();
  for (const replacesComponentId of [otherBikeId, replacedId, voidedId, randomUUID()])
    expect(await attempt({ ...INPUT, replacesComponentId }, LATER)).toEqual(INVALID_REPLACEMENT);
  expect(await snapshot()).toEqual(before);
});
it("rechaza una fecha anterior a la instalación previa antes del CHECK", async () => {
  const replacesComponentId = await install();
  const before = await snapshot();
  expect(
    await attempt({
      ...INPUT,
      replacesComponentId,
      installedAt: "2026-10-06",
    }),
  ).toEqual(INVALID_REPLACEMENT);
  expect(await snapshot()).toEqual(before);
});
it("protege órdenes y componentes de otras sucursales", async () => {
  const id = await install();
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const outsider = await actor(branch.id, "owner");
  const otherOrder = await createOrder(outsider);
  const foreign = await attempt(INPUT, NOW, outsider, otherOrder.id);
  if (!foreign.ok) throw new Error("No se instaló el componente.");
  const before = await snapshot();
  expect(await attempt(INPUT, NOW, outsider)).toEqual(failure("not_found"));
  expect(await voidComponent(test.db, outsider, id, NOW)).toEqual(failure("not_found"));
  expect(await listComponentsOfBike(test.db, outsider, order.bikeId)).toEqual([]);
  expect(await attempt({ ...INPUT, replacesComponentId: foreign.id })).toEqual(INVALID_REPLACEMENT);
  expect(await snapshot()).toEqual(before);
});
it("revalida acceso del mecánico y excluye órdenes anuladas o inexistentes", async () => {
  const anotherMechanic = await actor(owner.branchId, "mechanic");
  await test.db
    .update(workOrders)
    .set({ assignedMechanicId: anotherMechanic.id })
    .where(eq(workOrders.id, order.id));
  const before = await snapshot();
  expect(await attempt(INPUT, NOW, mechanic)).toEqual(FORBIDDEN);
  expect(await snapshot()).toEqual(before);
  expect((await attempt(INPUT, NOW, anotherMechanic)).ok).toBe(true);
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, order.id));
  const voided = await snapshot();
  for (const orderId of [order.id, randomUUID()])
    expect(await attempt(INPUT, NOW, owner, orderId)).toEqual(failure("not_found"));
  expect(await snapshot()).toEqual(voided);
});
it("valida longitudes, fechas reales y UUID; normaliza vacíos y admite revalidación", async () => {
  const input = componentFormSchema.parse({
    ...INPUT,
    componentType: " Cadena ",
    serialNumber: " ",
    workOrderItemId: "",
    replacesComponentId: "",
    installedAt: "",
  });
  expect(input).toEqual({
    ...INPUT,
    serialNumber: null,
    workOrderItemId: undefined,
    replacesComponentId: undefined,
    installedAt: undefined,
  });
  expect(componentFormSchema.parse(input)).toEqual(input);
  const before = await snapshot();
  for (const fields of [
    { componentType: "x" },
    { componentType: "x".repeat(61) },
    { brand: " " },
    { brand: "x".repeat(61) },
    { model: " " },
    { model: "x".repeat(81) },
    { serialNumber: "x".repeat(81) },
    { installedAt: "2026-02-30" },
    { installedAt: "08-10-2026" },
    { workOrderItemId: "x" },
    { replacesComponentId: "x" },
  ]) {
    expect(componentFormSchema.safeParse({ ...INPUT, ...fields }).success).toBe(false);
    expect(await attempt({ ...INPUT, ...fields })).toEqual(failure("validation_error"));
  }
  expect(await snapshot()).toEqual(before);
  expect((await attempt(input)).ok).toBe(true);
});
it("dos órdenes que reemplazan el mismo componente: solo una instalación se registra", async () => {
  const replacesComponentId = await install();
  const secondOrder = await createOrder(owner, order);
  const results = await Promise.all(
    [order.id, secondOrder.id].map((orderId) =>
      attempt({ ...INPUT, replacesComponentId }, LATER, owner, orderId),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([INVALID_REPLACEMENT]);
  expect(await test.db.select().from(bikeComponents)).toHaveLength(2);
  expect(await test.db.select().from(auditLog)).toHaveLength(2);
});
it("revierte la inserción cuando la actualización condicional no cambia filas", async () => {
  const replacesComponentId = await install();
  const before = await snapshot();
  await test.client.exec(`
    create function skip_component_update() returns trigger language plpgsql as $$
    begin return null; end; $$;
    create trigger skip_component_update before update on bike_components
    for each row execute function skip_component_update();
  `);
  expect(await attempt({ ...INPUT, replacesComponentId }, LATER)).toEqual(INVALID_REPLACEMENT);
  expect(await snapshot()).toEqual(before);
});
it("revierte instalación, reemplazo y anulación si falla la auditoría", async () => {
  const replacesComponentId = await install();
  const before = await snapshot();
  await test.client.exec(`
    create function reject_component_audit() returns trigger language plpgsql as $$
    begin raise exception 'Auditoría no disponible'; end; $$;
    create trigger reject_component_audit before insert on audit_log
    for each row execute function reject_component_audit();
  `);
  await expect(attempt({ ...INPUT, replacesComponentId }, LATER)).rejects.toThrow();
  await expect(voidComponent(test.db, owner, replacesComponentId, LATER)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
