import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { qcChecks, workOrders, workOrderStatusHistory } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { listQcChecks, qcFormSchema, submitQc } from "../../src/server/taller/qc.ts";
import { QC_CHECK_KEYS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let orderId: string;

function input(failed: (typeof QC_CHECK_KEYS)[number][] = []) {
  return qcFormSchema.parse({
    checks: Object.fromEntries(
      QC_CHECK_KEYS.map((key) => [
        key,
        {
          result: failed.includes(key) ? "falla" : "ok",
          note: key === "frenos" ? "  Ajuste revisado  " : "",
        },
      ]),
    ),
  });
}

async function createUser(branchId: string, role: "owner" | "mechanic") {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: role,
      email: `${role}@example.test`,
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
      status: "control_calidad",
      assignedMechanicId: mechanic.id,
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

async function savedOrder() {
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  return order;
}

async function expectNoChanges() {
  expect(await test.db.select().from(qcChecks)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await createUser(branch.id, "owner");
  mechanic = await createUser(branch.id, "mechanic");
  orderId = await createOrder();
  return () => test.close();
});

it("1: aprueba siete puntos, guarda autor y fecha, y pasa a lista para retirar", async () => {
  expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
    ok: true,
    status: "lista_para_retirar",
  });
  expect(await savedOrder()).toMatchObject({
    status: "lista_para_retirar",
    qcApprovedAt: NOW,
    qcApprovedBy: owner.id,
    qcSelfChecked: false,
    updatedAt: NOW,
  });
  const rows = await listQcChecks(test.db, owner, orderId);
  expect(rows).toHaveLength(7);
  expect(rows.map((row) => row.itemKey).sort()).toEqual([...QC_CHECK_KEYS].sort());
  for (const row of rows)
    expect(row).toMatchObject({
      branchId: owner.branchId,
      workOrderId: orderId,
      result: "ok",
      actorUserId: owner.id,
      selfCheck: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
  expect(rows.find((row) => row.itemKey === "frenos")?.note).toBe("Ajuste revisado");
  expect(rows.find((row) => row.itemKey === "limpieza")?.note).toBeNull();
  expect(await test.db.select().from(workOrderStatusHistory)).toMatchObject([
    {
      branchId: owner.branchId,
      workOrderId: orderId,
      fromStatus: "control_calidad",
      toStatus: "lista_para_retirar",
      actorUserId: owner.id,
      note: null,
      createdAt: NOW,
    },
  ]);
});

it("audita la aprobación sin incluir notas", async () => {
  await submitQc(test.db, owner, orderId, input(), NOW);
  expect(await test.db.select().from(auditLog)).toMatchObject([
    {
      branchId: owner.branchId,
      actorUserId: owner.id,
      action: "qc.approved",
      entity: "work_order",
      entityId: orderId,
      details: { selfCheck: false },
      createdAt: NOW,
    },
  ]);
  expect((await test.db.select().from(auditLog))[0]?.details).toEqual({ selfCheck: false });
  expect(JSON.stringify(await test.db.select().from(auditLog))).not.toContain("Ajuste revisado");
});

it.each(["own", "unassigned"])("2: marca autocontrol cuando la orden es %s", async (kind) => {
  await test.db
    .update(workOrders)
    .set({ assignedMechanicId: kind === "own" ? owner.id : null })
    .where(eq(workOrders.id, orderId));
  expect((await submitQc(test.db, owner, orderId, input(), NOW)).ok).toBe(true);
  expect(await savedOrder()).toMatchObject({ qcSelfChecked: true, qcApprovedBy: owner.id });
  const rows = await listQcChecks(test.db, owner, orderId);
  expect(rows).toHaveLength(7);
  expect(rows.every((row) => row.selfCheck)).toBe(true);
  expect((await test.db.select().from(auditLog))[0]?.details).toEqual({ selfCheck: true });
});

it.each(["mechanic", "admin", "reception"] as const)(
  "3: rechaza %s sin tocar filas",
  async (role) => {
    const original = await savedOrder();
    expect(await submitQc(test.db, { ...owner, role }, orderId, input(), NOW)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await savedOrder()).toEqual(original);
    await expectNoChanges();
    expect(await submitQc({} as AppDb, { ...owner, role }, orderId, null, NOW)).toEqual({
      ok: false,
      code: "forbidden",
    });
  },
);

it("4: guarda fallas, vuelve a reparación y audita solo sus claves", async () => {
  expect(await submitQc(test.db, owner, orderId, input(["frenos", "limpieza"]), NOW)).toEqual({
    ok: true,
    status: "en_reparacion",
  });
  expect(await savedOrder()).toMatchObject({
    status: "en_reparacion",
    qcApprovedAt: null,
    qcApprovedBy: null,
    qcSelfChecked: false,
  });
  const rows = await listQcChecks(test.db, owner, orderId);
  expect(rows).toHaveLength(7);
  expect(
    rows
      .filter((row) => row.result === "falla")
      .map((row) => row.itemKey)
      .sort(),
  ).toEqual(["frenos", "limpieza"]);
  expect(await test.db.select().from(workOrderStatusHistory)).toMatchObject([
    {
      fromStatus: "control_calidad",
      toStatus: "en_reparacion",
      note: "Control rechazado",
    },
  ]);
  const audit = await test.db.select().from(auditLog);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "qc.rejected",
    actorUserId: owner.id,
    entityId: orderId,
  });
  expect(audit[0]?.details).toEqual({ failedItems: ["frenos", "limpieza"] });
  expect(JSON.stringify(audit)).not.toContain("Ajuste revisado");
});

it.each(["reservada", "en_reparacion"])("5: rechaza el estado %s sin cambios", async (status) => {
  await test.db.update(workOrders).set({ status }).where(eq(workOrders.id, orderId));
  const original = await savedOrder();
  expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  expect(await savedOrder()).toEqual(original);
  await expectNoChanges();
});

it("la base rechaza lista para retirar sin aprobación con 23514", async () => {
  await expect(
    test.client.query(`update work_orders set status = 'lista_para_retirar' where id = $1`, [
      orderId,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await savedOrder()).toMatchObject({ status: "control_calidad", qcApprovedAt: null });
});

it("conserva las rondas rechazadas al aprobar un nuevo control", async () => {
  await submitQc(test.db, owner, orderId, input(["frenos"]), NOW);
  await test.db
    .update(workOrders)
    .set({ status: "control_calidad" })
    .where(eq(workOrders.id, orderId));
  const later = new Date("2026-10-08T16:00:00.000Z");
  await submitQc(test.db, owner, orderId, input(), later);
  const rows = await listQcChecks(test.db, owner, orderId);
  expect(rows).toHaveLength(14);
  expect(rows.filter((row) => row.createdAt.getTime() === NOW.getTime())).toHaveLength(7);
  expect(rows.filter((row) => row.createdAt.getTime() === later.getTime())).toHaveLength(7);
  expect(rows.filter((row) => row.result === "falla")).toHaveLength(1);
  expect(await savedOrder()).toMatchObject({ status: "lista_para_retirar", qcApprovedAt: later });
});

it("no registra otra ronda tras aprobar la orden", async () => {
  await submitQc(test.db, owner, orderId, input(), NOW);
  expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  expect(await listQcChecks(test.db, owner, orderId)).toHaveLength(7);
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it("limita escritura e historial a la sucursal y acceso a la orden", async () => {
  const foreign = { ...owner, branchId: randomUUID() };
  expect(await submitQc(test.db, foreign, orderId, input(), NOW)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  await expectNoChanges();
  await submitQc(test.db, owner, orderId, input(), NOW);
  expect(await listQcChecks(test.db, foreign, orderId)).toEqual([]);
  expect(await listQcChecks(test.db, { ...mechanic, id: randomUUID() }, orderId)).toEqual([]);
  expect(await listQcChecks(test.db, mechanic, orderId)).toHaveLength(7);
  expect(await listQcChecks(test.db, { ...owner, role: "reception" }, orderId)).toHaveLength(7);
});

it("rechaza órdenes inexistentes o anuladas sin guardar controles", async () => {
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
  for (const id of [orderId, randomUUID()]) {
    expect(await submitQc(test.db, owner, id, input(), NOW)).toEqual({
      ok: false,
      code: "invalid_status",
    });
    expect(await listQcChecks(test.db, owner, id)).toEqual([]);
  }
  await expectNoChanges();
});

it("exige los siete puntos, resultados válidos y notas de máximo 300", async () => {
  const complete = input();
  const partial = Object.fromEntries(
    Object.entries(complete.checks).filter(([key]) => key !== "frenos"),
  );
  const invalid = [
    { checks: partial },
    { checks: { ...complete.checks, frenos: { result: "revisar" } } },
    { checks: { ...complete.checks, frenos: { result: "ok", note: "a".repeat(301) } } },
  ];
  for (const value of invalid) {
    expect(await submitQc(test.db, owner, orderId, value, NOW)).toEqual({
      ok: false,
      code: "validation_error",
    });
  }
  await expectNoChanges();
});

it("revierte controles y cambio de estado si falla la auditoría", async () => {
  await test.client.exec(
    `alter table audit_log add constraint test_reject_qc check (action <> 'qc.approved')`,
  );
  await expect(submitQc(test.db, owner, orderId, input(), NOW)).rejects.toThrow();
  expect(await savedOrder()).toMatchObject({ status: "control_calidad", qcApprovedAt: null });
  await expectNoChanges();
});

it("rechaza claves y resultados inválidos también en la base", async () => {
  for (const [itemKey, result] of [
    ["cadena", "ok"],
    ["frenos", "revisar"],
  ]) {
    await expect(
      test.client.query(
        `insert into qc_checks
      (branch_id, work_order_id, item_key, result, actor_user_id)
      values ($1, $2, $3, $4, $5)`,
        [owner.branchId, orderId, itemKey, result, owner.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expectNoChanges();
});
