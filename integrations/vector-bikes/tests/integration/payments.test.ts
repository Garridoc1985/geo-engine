import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { payments, workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  listPayments,
  paymentFormSchema,
  recordPayment,
  voidPayment,
} from "../../src/server/taller/payments.ts";
import { TERMINAL_STATUSES } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
const LATER = new Date("2026-10-08T16:00:00.000Z");
const DEPOSIT = { kind: "abono", method: "transferencia", amountClp: 20000 } as const;
const FINAL = { kind: "final", method: "tarjeta", amountClp: 30000 } as const;
const FORBIDDEN = { ok: false, code: "forbidden" };
const INVALID_AMOUNT = { ok: false, code: "invalid_amount" };
let test: TestDb;
let owner: SessionUser;
let admin: SessionUser;
let reception: SessionUser;
let mechanic: SessionUser;
let orderId: string;

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
    .values({ branchId: owner.branchId, name: "Cliente de prueba", phoneE164: "+56912345678" })
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
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      status: "recibida",
      requestedService: "Revisión general",
      totalClp: 50000,
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

async function snapshot() {
  return {
    orders: await test.db.select().from(workOrders),
    payments: await test.db.select().from(payments),
    audits: await test.db.select().from(auditLog),
  };
}

async function orderRow() {
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  if (!order) throw new Error("Falta la orden de prueba.");
  return order;
}

async function deposit(staff = owner) {
  const result = await recordPayment(test.db, staff, orderId, DEPOSIT, NOW);
  if (!result.ok) throw new Error("No se registró el abono.");
  return result.paymentId;
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
  return () => test.close();
});

it.each(["owner", "admin", "reception"] as const)(
  "1: %s registra abono, recalcula los pagos y audita sin datos personales",
  async (role) => {
    const staff = { owner, admin, reception }[role];
    const paymentId = await deposit(staff);
    expect((await listPayments(test.db, staff, orderId))[0]).toMatchObject({
      id: paymentId,
      ...DEPOSIT,
      branchId: staff.branchId,
      workOrderId: orderId,
      receivedBy: staff.id,
      receivedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await orderRow()).toMatchObject({ paidClp: 20000, updatedAt: NOW });
    const rows = await test.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payment.recorded"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: staff.id,
      branchId: staff.branchId,
      entityId: orderId,
      createdAt: NOW,
    });
    expect(rows[0]?.details).toEqual(DEPOSIT);
    expect((await recordPayment(test.db, staff, orderId, FINAL, LATER)).ok).toBe(true);
    expect(await orderRow()).toMatchObject({ paidClp: 50000, updatedAt: LATER });
  },
);

it("2: el índice único rechaza el segundo abono vigente sin cambios", async () => {
  await deposit();
  const before = await snapshot();
  expect(await recordPayment(test.db, owner, orderId, DEPOSIT, LATER)).toEqual({
    ok: false,
    code: "deposit_exists",
  });
  await expect(
    test.db.insert(payments).values({
      ...DEPOSIT,
      branchId: owner.branchId,
      workOrderId: orderId,
      receivedBy: owner.id,
      receivedAt: LATER,
    }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

it("3: rechaza montos que superan el saldo o no son positivos", async () => {
  await deposit();
  const before = await snapshot();
  for (const amountClp of [30001, 50000, 0, -1]) {
    expect(await recordPayment(test.db, owner, orderId, { ...FINAL, amountClp }, LATER)).toEqual(
      INVALID_AMOUNT,
    );
  }
  expect(await snapshot()).toEqual(before);
});

it.each(["owner", "admin"] as const)(
  "4: %s anula sin borrar y permite otro abono",
  async (role) => {
    const staff = role === "owner" ? owner : admin;
    const paymentId = await deposit();
    await recordPayment(test.db, reception, orderId, { ...FINAL, amountClp: 10000 }, NOW);
    expect(await voidPayment(test.db, staff, paymentId, LATER)).toEqual({ ok: true });
    const [payment] = await test.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(payment).toMatchObject({
      id: paymentId,
      voidedAt: LATER,
      voidedBy: staff.id,
      updatedAt: LATER,
    });
    expect(await orderRow()).toMatchObject({ paidClp: 10000, updatedAt: LATER });
    expect((await listPayments(test.db, staff, orderId)).map((row) => row.id)).not.toContain(
      paymentId,
    );
    const [audit] = await test.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payment.voided"));
    expect(audit?.details).toEqual({ paymentId, kind: "abono", amountClp: 20000 });
    const before = await snapshot();
    expect(await voidPayment(test.db, staff, paymentId, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await snapshot()).toEqual(before);
    expect((await recordPayment(test.db, reception, orderId, DEPOSIT, LATER)).ok).toBe(true);
    expect(await test.db.select().from(payments)).toHaveLength(3);
    expect(await orderRow()).toMatchObject({ paidClp: 30000 });
  },
);

it("5: el mecánico no registra pagos y el permiso precede a la validación", async () => {
  const before = await snapshot();
  expect(await recordPayment(test.db, mechanic, orderId, DEPOSIT, NOW)).toEqual(FORBIDDEN);
  expect(await recordPayment(test.db, mechanic, randomUUID(), null, NOW)).toEqual(FORBIDDEN);
  expect(await snapshot()).toEqual(before);
});

it("no permite anular un pago de una orden entregada y mantiene el CHECK", async () => {
  const paymentId = await deposit();
  await recordPayment(test.db, owner, orderId, FINAL, NOW);
  await test.db
    .update(workOrders)
    .set({ status: "entregada", qcApprovedAt: NOW })
    .where(eq(workOrders.id, orderId));
  const before = await snapshot();
  expect(await voidPayment(test.db, owner, paymentId, LATER)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  await expect(
    test.db.update(workOrders).set({ paidClp: 0 }).where(eq(workOrders.id, orderId)),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

it("dos pagos concurrentes que exceden el saldo juntos: solo uno se registra", async () => {
  const input = { ...FINAL, amountClp: 30000 };
  const results = await Promise.all([
    recordPayment(test.db, owner, orderId, input, NOW),
    recordPayment(test.db, reception, orderId, input, NOW),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([INVALID_AMOUNT]);
  expect(await listPayments(test.db, owner, orderId)).toHaveLength(1);
  expect(await orderRow()).toMatchObject({ paidClp: 30000 });
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it.each(TERMINAL_STATUSES)("rechaza registrar pagos en %s", async (status) => {
  await test.db
    .update(workOrders)
    .set({ status, paidClp: 50000, qcApprovedAt: NOW })
    .where(eq(workOrders.id, orderId));
  const before = await snapshot();
  expect(await recordPayment(test.db, owner, orderId, DEPOSIT, NOW)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  expect(await snapshot()).toEqual(before);
});

it("solo administradores anulan pagos", async () => {
  const paymentId = await deposit();
  const before = await snapshot();
  for (const staff of [reception, mechanic]) {
    expect(await voidPayment(test.db, staff, paymentId, LATER)).toEqual(FORBIDDEN);
    expect(await voidPayment(test.db, staff, randomUUID(), LATER)).toEqual(FORBIDDEN);
  }
  expect(await snapshot()).toEqual(before);
});

it("protege pagos de otra sucursal y de órdenes anuladas", async () => {
  const paymentId = await deposit();
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const outsider = await actor(branch.id, "owner");
  for (const staff of [outsider, owner]) {
    if (staff === owner)
      await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
    const before = await snapshot();
    expect(await recordPayment(test.db, staff, orderId, FINAL, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await voidPayment(test.db, staff, paymentId, LATER)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await listPayments(test.db, staff, orderId)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }
});

it("valida tipo, método y CLP enteros sin coerciones vacías", async () => {
  const before = await snapshot();
  for (const amountClp of [1.5, "", null, true, 2147483648]) {
    const input = { ...FINAL, amountClp };
    expect(paymentFormSchema.safeParse(input).success).toBe(false);
    expect(await recordPayment(test.db, owner, orderId, input, NOW)).toEqual(INVALID_AMOUNT);
  }
  for (const input of [
    { ...DEPOSIT, kind: "otro" },
    { ...DEPOSIT, method: "cheque" },
  ]) {
    expect(await recordPayment(test.db, owner, orderId, input, NOW)).toEqual({
      ok: false,
      code: "validation_error",
    });
  }
  expect(await snapshot()).toEqual(before);
  expect(
    (await recordPayment(test.db, owner, orderId, { ...FINAL, amountClp: "50000" }, NOW)).ok,
  ).toBe(true);
});

it("revierte registro, anulación y saldo cuando falla la auditoría", async () => {
  const paymentId = await deposit();
  const before = await snapshot();
  await test.client.exec(`
    create function reject_payment_audit() returns trigger language plpgsql as $$
    begin raise exception 'Auditoría no disponible'; end; $$;
    create trigger reject_payment_audit before insert on audit_log
    for each row execute function reject_payment_audit();
  `);
  await expect(recordPayment(test.db, owner, orderId, FINAL, LATER)).rejects.toThrow();
  await expect(voidPayment(test.db, owner, paymentId, LATER)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
