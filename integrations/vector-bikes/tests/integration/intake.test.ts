import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { intakeAccessories, intakeChecks, workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  addAccessory,
  checklistFormSchema,
  isChecklistComplete,
  listAccessories,
  listIntakeChecks,
  saveChecklist,
  voidAccessory,
} from "../../src/server/taller/intake.ts";
import { startReception } from "../../src/server/taller/orders.ts";
import { INTAKE_CHECK_KEYS, INTAKE_RESULTS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-07T15:00:00.000Z");
const LATER = new Date("2026-10-07T16:00:00.000Z");
let test: TestDb;
let mechanic: SessionUser;
let orderId: string;

async function createActor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      email: `${randomUUID()}@example.test`,
      name: "Personal de prueba",
      passwordHash: "hash-de-prueba",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, email: user.email, name: user.name };
}

function input() {
  return checklistFormSchema.parse({
    checks: Object.fromEntries(
      INTAKE_CHECK_KEYS.map((key, index) => [
        key,
        {
          result: INTAKE_RESULTS[index % INTAKE_RESULTS.length],
          note: `Nota de ${key}`,
        },
      ]),
    ),
    observaciones: "Bicicleta con rayas en el marco",
    servicio_solicitado: "Revisión general",
  });
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  mechanic = await createActor(branch.id, "mechanic");
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: branch.id,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: branch.id,
      customerId: customer.id,
      brand: "Specialized",
      model: "Rockhopper",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const reception = await startReception(
    test.db,
    mechanic,
    {
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Servicio inicial",
    },
    NOW,
  );
  if (!reception.ok) throw new Error("Falta la orden de prueba.");
  orderId = reception.orderId;
  return () => test.close();
});

it("1: guarda los siete puntos y reconoce el checklist completo", async () => {
  expect(await isChecklistComplete(test.db, orderId)).toBe(false);
  const data = input();
  expect(await saveChecklist(test.db, mechanic, orderId, data, NOW)).toEqual({ ok: true });
  const rows = await listIntakeChecks(test.db, mechanic, orderId);
  expect(rows).toHaveLength(7);
  for (const key of INTAKE_CHECK_KEYS) {
    expect(rows.find((row) => row.itemKey === key)).toMatchObject({
      branchId: mechanic.branchId,
      workOrderId: orderId,
      itemKey: key,
      ...data.checks[key],
      createdBy: mechanic.id,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  expect(await isChecklistComplete(test.db, orderId)).toBe(true);
  expect(await isChecklistComplete(test.db, randomUUID())).toBe(false);
});

it("2: vuelve a guardar un punto mediante upsert sin duplicarlo", async () => {
  await saveChecklist(test.db, mechanic, orderId, input(), NOW);
  const before = await listIntakeChecks(test.db, mechanic, orderId);
  const data = { ...input(), checks: { frenos: { result: "malo", note: "Pastillas gastadas" } } };
  expect(await saveChecklist(test.db, mechanic, orderId, data, LATER)).toEqual({ ok: true });
  const after = await listIntakeChecks(test.db, mechanic, orderId);
  expect(after).toHaveLength(7);
  expect(after.find((row) => row.itemKey === "frenos")).toMatchObject({
    id: before.find((row) => row.itemKey === "frenos")?.id,
    result: "malo",
    note: "Pastillas gastadas",
    createdAt: NOW,
    updatedAt: LATER,
  });
  expect(after.filter((row) => row.itemKey !== "frenos")).toEqual(
    before.filter((row) => row.itemKey !== "frenos"),
  );
});

it("3: quita un accesorio conservando su fila y autor de anulación", async () => {
  const added = await addAccessory(
    test.db,
    mechanic,
    orderId,
    { description: "Luz delantera" },
    NOW,
  );
  if (!added.ok) throw new Error("Falta el accesorio de prueba.");
  expect(await listAccessories(test.db, mechanic, orderId)).toEqual([added.accessory]);
  expect(await voidAccessory(test.db, mechanic, added.accessory.id, LATER)).toEqual({ ok: true });
  expect(await listAccessories(test.db, mechanic, orderId)).toEqual([]);
  const [retained] = await test.db
    .select()
    .from(intakeAccessories)
    .where(eq(intakeAccessories.id, added.accessory.id));
  expect(retained).toMatchObject({
    id: added.accessory.id,
    description: "Luz delantera",
    branchId: mechanic.branchId,
    createdBy: mechanic.id,
    createdAt: NOW,
    voidedAt: LATER,
    voidedBy: mechanic.id,
    updatedAt: LATER,
  });
  await voidAccessory(test.db, mechanic, added.accessory.id, NOW);
  const [again] = await test.db
    .select()
    .from(intakeAccessories)
    .where(eq(intakeAccessories.id, added.accessory.id));
  expect(again).toEqual(retained);
});

it("4: guarda observaciones y servicio solicitado sin escribir textos en auditoría", async () => {
  const audits = await test.db.select().from(auditLog);
  expect(await saveChecklist(test.db, mechanic, orderId, input(), LATER)).toEqual({ ok: true });
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  expect(order).toMatchObject({
    observations: input().observaciones,
    requestedService: input().servicio_solicitado,
    updatedAt: LATER,
  });
  const added = await addAccessory(test.db, mechanic, orderId, { description: "Bolso" }, NOW);
  if (!added.ok) throw new Error("Falta el accesorio de prueba.");
  await voidAccessory(test.db, mechanic, added.accessory.id, LATER);
  expect(await test.db.select().from(auditLog)).toEqual(audits);
});

it("exige las siete claves para completitud y admite guardar un avance", async () => {
  const data = input();
  delete data.checks.problemas_visibles;
  await saveChecklist(test.db, mechanic, orderId, data, NOW);
  expect(await listIntakeChecks(test.db, mechanic, orderId)).toHaveLength(6);
  expect(await isChecklistComplete(test.db, orderId)).toBe(false);
});

it("restringe lecturas y cambios por sucursal y acceso del mecánico", async () => {
  const otherMechanic = await createActor(mechanic.branchId, "mechanic");
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la otra sucursal.");
  const otherBranch = await createActor(branch.id, "owner");
  await saveChecklist(test.db, mechanic, orderId, input(), NOW);
  const added = await addAccessory(test.db, mechanic, orderId, { description: "Casco" }, NOW);
  if (!added.ok) throw new Error("Falta el accesorio de prueba.");
  for (const [actor, code] of [
    [otherMechanic, "forbidden"],
    [otherBranch, "not_found"],
  ] as const) {
    expect(await saveChecklist(test.db, actor, orderId, input(), LATER)).toEqual({
      ok: false,
      code,
    });
    expect(await addAccessory(test.db, actor, orderId, { description: "Otro" }, LATER)).toEqual({
      ok: false,
      code,
    });
    expect(await voidAccessory(test.db, actor, added.accessory.id, LATER)).toEqual({
      ok: false,
      code,
    });
    expect(await listIntakeChecks(test.db, actor, orderId)).toEqual([]);
    expect(await listAccessories(test.db, actor, orderId)).toEqual([]);
  }
  expect(await listAccessories(test.db, mechanic, orderId)).toEqual([added.accessory]);
});

it("solo guarda checklist en reservada o recibida", async () => {
  await test.db
    .update(workOrders)
    .set({ status: "recibida", assignedMechanicId: null })
    .where(eq(workOrders.id, orderId));
  expect(await saveChecklist(test.db, mechanic, orderId, input(), NOW)).toEqual({ ok: true });
  const before = await listIntakeChecks(test.db, mechanic, orderId);
  await test.db.update(workOrders).set({ status: "diagnostico" }).where(eq(workOrders.id, orderId));
  expect(await saveChecklist(test.db, mechanic, orderId, input(), LATER)).toEqual({
    ok: false,
    code: "invalid_state",
  });
  expect(await listIntakeChecks(test.db, mechanic, orderId)).toEqual(before);
});

it("valida resultados, claves y longitudes antes de escribir", async () => {
  for (const changes of [
    { checks: { frenos: { result: "otro" } } },
    { checks: { desconocido: { result: "ok" } } },
    { checks: { frenos: { result: "ok", note: "x".repeat(301) } } },
    { observaciones: "x".repeat(2001) },
    { servicio_solicitado: "ab" },
    { servicio_solicitado: "x".repeat(501) },
  ]) {
    expect(
      await saveChecklist(test.db, mechanic, orderId, { ...input(), ...changes }, NOW),
    ).toEqual({ ok: false, code: "validation_error" });
  }
  expect(await test.db.select().from(intakeChecks)).toEqual([]);
  expect(await addAccessory(test.db, mechanic, orderId, { description: " " }, NOW)).toEqual({
    ok: false,
    code: "validation_error",
  });
});

it("revierte los puntos si falla la actualización de la orden en la misma transacción", async () => {
  await test.db.execute(
    sql`alter table work_orders add constraint test_requested_service_check check (requested_service <> 'Revisión general')`,
  );
  await expect(saveChecklist(test.db, mechanic, orderId, input(), LATER)).rejects.toThrow();
  expect(await test.db.select().from(intakeChecks)).toEqual([]);
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  expect(order).toMatchObject({
    observations: null,
    requestedService: "Servicio inicial",
    updatedAt: NOW,
  });
});
