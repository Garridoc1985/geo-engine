import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { can } from "../../src/server/auth/permissions.ts";
import { workOrders, workOrderStatusHistory } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { bookings, branches, users } from "../../src/server/db/schema.ts";
import { insertBike } from "../../src/server/taller/bikes.ts";
import { customerFormSchema, insertCustomer } from "../../src/server/taller/customers.ts";
import {
  formatOrderNumber,
  getOrderHeader,
  prefillFromBooking,
  recordStatusChange,
  startReception,
  startReceptionSchema,
} from "../../src/server/taller/orders.ts";
import { isAllowedTransition, isManualTransition } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-07T15:00:00.000Z");
const newBike = { brand: "Trek", model: "Marlin 7", bikeType: "mtb" };
const newCustomer = { name: "Cliente nuevo", phoneE164: "955556666", email: "nuevo@example.test" };
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let other: SessionUser;
let customerId: string;
let bikeId: string;

async function actor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
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

async function booking(phoneE164 = "+56912345678") {
  const [row] = await test.db
    .insert(bookings)
    .values({
      code: randomUUID(),
      serviceDate: "2026-10-08",
      mode: "taller",
      startsAt: new Date("2026-10-08T15:00:00Z"),
      endsAt: new Date("2026-10-08T16:00:00Z"),
      customerName: "Carla Reserva",
      phoneE164,
      email: "carla@example.test",
      bike: "Specialized Stumpjumper EVO",
      description: "Mantención general",
      consentAt: NOW,
      cancelTokenHash: randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  if (!row) throw new Error("Falta la reserva de prueba.");
  return row;
}

function input(changes: Record<string, unknown> = {}) {
  return { customerId, bikeId, requestedService: "Revisar frenos", ...changes };
}

async function create(user = owner, changes: Record<string, unknown> = {}) {
  const result = await startReception(test.db, user, input(changes), NOW);
  if (!result.ok) throw new Error(`No se creó la orden: ${result.code}`);
  return result;
}

function databaseError(error: unknown) {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const detail = error as { code?: string; constraint?: string; cause?: unknown };
    if (detail.code) return detail;
    error = detail.cause;
  }
  return null;
}

async function expectCheck(query: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(query).then(() => null, databaseError);
  expect(error).toMatchObject({ code: "23514", constraint });
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch, another] = await test.db
    .insert(branches)
    .values([
      { name: "Vitacura", createdAt: NOW, updatedAt: NOW },
      { name: "Otra sucursal", createdAt: NOW, updatedAt: NOW },
    ])
    .returning();
  if (!branch || !another) throw new Error("Faltan las sucursales de prueba.");
  owner = await actor(branch.id, "owner");
  mechanic = await actor(branch.id, "mechanic");
  other = await actor(another.id, "owner");
  const customer = await insertCustomer(
    test.db,
    branch.id,
    customerFormSchema.parse({
      name: "Cliente existente",
      phoneE164: "912345678",
    }),
    NOW,
  );
  if (!customer.ok) throw new Error("Falta el cliente de prueba.");
  customerId = customer.customer.id;
  const bike = await insertBike(test.db, branch.id, customerId, newBike, NOW);
  if (!bike.ok) throw new Error("Falta la bicicleta de prueba.");
  bikeId = bike.bike.id;
  return () => test.close();
});

it("1: diez recepciones concurrentes asignan 1 a 10 y dejan el contador en 11", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => startReception(test.db, owner, input(), NOW)),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  const numbers = results
    .flatMap((result) => (result.ok ? [result.number] : []))
    .sort((a, b) => a - b);
  expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const [branch] = await test.db.select().from(branches).where(eq(branches.id, owner.branchId));
  expect(branch?.nextOrderNumber).toBe(11);
  expect(await test.db.select().from(workOrders)).toHaveLength(10);
});

it("2: formatea los números de orden con el prefijo y cinco dígitos", () => {
  expect(formatOrderNumber(1)).toBe("OT-00001");
  expect(formatOrderNumber(12345)).toBe("OT-12345");
});

it("3: prellena la reserva con la ficha y bicicletas existentes o con sus datos", async () => {
  const existing = await booking();
  const known = await prefillFromBooking(test.db, owner, existing.id);
  expect(known?.booking).toEqual(existing);
  expect(known?.existingCustomer).toMatchObject({
    id: customerId,
    name: "Cliente existente",
    bikes: [{ id: bikeId }],
  });
  const unknown = await booking("+56999998888");
  const prefill = await prefillFromBooking(test.db, owner, unknown.id);
  expect(prefill?.existingCustomer).toBeNull();
  expect(prefill?.prefill).toEqual({
    name: unknown.customerName,
    phoneE164: unknown.phoneE164,
    email: unknown.email,
    brand: "Specialized",
    model: "Stumpjumper EVO",
    requestedService: unknown.description,
  });
  expect((await prefillFromBooking(test.db, other, existing.id))?.existingCustomer).toBeNull();
  expect(await prefillFromBooking(test.db, owner, randomUUID())).toBeNull();
});

it("4: crea una orden reservada con historial, autor, auditoría y asignación al mecánico", async () => {
  const result = await create(mechanic);
  const header = await getOrderHeader(test.db, mechanic, result.orderId);
  expect(header?.order).toMatchObject({
    branchId: owner.branchId,
    number: result.number,
    status: "reservada",
    customerId,
    bikeId,
    bookingId: null,
    createdBy: mechanic.id,
    assignedMechanicId: mechanic.id,
    totalClp: 0,
    paidClp: 0,
    estimatedMinutes: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(header?.customer.id).toBe(customerId);
  expect(header?.bike.id).toBe(bikeId);
  expect(await getOrderHeader(test.db, other, result.orderId)).toBeNull();
  expect(await getOrderHeader(test.db, owner, randomUUID())).toBeNull();
  const history = await test.db.select().from(workOrderStatusHistory);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    branchId: owner.branchId,
    workOrderId: result.orderId,
    fromStatus: null,
    toStatus: "reservada",
    actorUserId: mechanic.id,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const audit = await test.db.select().from(auditLog);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: mechanic.id,
    action: "order.created",
    entity: "work_order",
    entityId: result.orderId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(audit[0]?.details).toEqual({ number: result.number });
});

it("5: SQL directo no puede entregar con saldo pendiente, incluso con QC aprobado", async () => {
  const order = await create();
  await expectCheck(
    test.db.execute(sql`
    update work_orders set status = 'entregada', total_clp = 10000, paid_clp = 5000,
    qc_approved_at = ${NOW} where id = ${order.orderId}
  `),
    "work_orders_delivered_paid_check",
  );
  expect((await getOrderHeader(test.db, owner, order.orderId))?.order.status).toBe("reservada");
});

it("6: SQL directo no puede dejar lista para retirar sin QC", async () => {
  const order = await create();
  await expectCheck(
    test.db.execute(sql`
    update work_orders set status = 'lista_para_retirar', qc_approved_at = null
    where id = ${order.orderId}
  `),
    "work_orders_qc_check",
  );
  expect((await getOrderHeader(test.db, owner, order.orderId))?.order.status).toBe("reservada");
});

it("el mecánico crea un cliente y una bicicleta nuevos en recepción sin customers.manage", async () => {
  expect(can(mechanic.role, "customers.manage")).toBe(false);
  const result = await startReception(
    test.db,
    mechanic,
    {
      customer: newCustomer,
      bike: newBike,
      requestedService: "Mantención general",
    },
    NOW,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Falló la recepción del mecánico.");
  const header = await getOrderHeader(test.db, mechanic, result.orderId);
  expect(header?.customer).toMatchObject({
    name: newCustomer.name,
    phoneE164: "+56955556666",
    branchId: mechanic.branchId,
  });
  expect(header?.bike).toMatchObject({
    ...newBike,
    customerId: header?.customer.id,
    branchId: mechanic.branchId,
  });
  expect(header?.order).toMatchObject({
    assignedMechanicId: mechanic.id,
    createdBy: mechanic.id,
    bookingId: null,
  });
  expect(await test.db.select().from(customers)).toHaveLength(2);
  expect(await test.db.select().from(bikes)).toHaveLength(2);
});

it("rechaza reservas inexistentes o tomadas y no altera la reserva ni el contador", async () => {
  const reserved = await booking();
  const order = await create(owner, { bookingId: reserved.id });
  expect(
    (await getOrderHeader(test.db, owner, order.orderId))?.order.assignedMechanicId,
  ).toBeNull();
  for (const bookingId of [reserved.id, randomUUID()]) {
    expect(await startReception(test.db, owner, input({ bookingId }), NOW)).toEqual({
      ok: false,
      code: "booking_taken",
    });
  }
  expect((await test.db.select().from(bookings).where(eq(bookings.id, reserved.id)))[0]).toEqual(
    reserved,
  );
  expect(
    (await test.db.select().from(branches).where(eq(branches.id, owner.branchId)))[0]
      ?.nextOrderNumber,
  ).toBe(2);
});

it("dos recepciones concurrentes de una reserva crean una sola orden", async () => {
  const reserved = await booking();
  const results = await Promise.all(
    Array.from({ length: 2 }, () =>
      startReception(test.db, owner, input({ bookingId: reserved.id }), NOW),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "booking_taken" }]);
  expect(await test.db.select().from(workOrders)).toHaveLength(1);
});

it("devuelve duplicate con la ficha existente sin crear bicicleta, orden ni número", async () => {
  const data = {
    customer: { ...newCustomer, phoneE164: "912345678" },
    bike: newBike,
    requestedService: "Mantención",
  };
  const result = await startReception(test.db, mechanic, data, NOW);
  expect(result).toEqual({
    ok: false,
    code: "duplicate",
    existing: { id: customerId, name: "Cliente existente" },
  });
  expect(await test.db.select().from(customers)).toHaveLength(1);
  expect(await test.db.select().from(bikes)).toHaveLength(1);
  expect(await test.db.select().from(workOrders)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  expect((await create()).number).toBe(1);
});

it("revierte el cliente nuevo si la bicicleta no le pertenece", async () => {
  const data = { customer: newCustomer, bikeId, requestedService: "Mantención" };
  const result = await startReception(test.db, mechanic, data, NOW);
  expect(result).toEqual({ ok: false, code: "not_found" });
  expect(await test.db.select().from(customers)).toHaveLength(1);
  expect(await test.db.select().from(bikes)).toHaveLength(1);
  expect(await test.db.select().from(workOrders)).toEqual([]);
  expect((await create()).number).toBe(1);
});

it("valida la selección de ficha o datos nuevos y el servicio antes de escribir", async () => {
  for (const changes of [
    { customerId: null },
    { bikeId: null },
    { customer: newCustomer },
    { bike: newBike },
    { requestedService: " " },
    { customerId: "inválido" },
    { bookingId: "inválido" },
    { bikeId: null, bike: { ...newBike, bikeType: "bmx" } },
  ]) {
    expect(startReceptionSchema.safeParse(input(changes)).success).toBe(false);
    expect(await startReception(test.db, owner, input(changes), NOW)).toEqual({
      ok: false,
      code: "validation_error",
    });
  }
  expect(await test.db.select().from(workOrders)).toEqual([]);
  expect((await create()).number).toBe(1);
});

it("valida transiciones y escribe historial con nota solo cuando está permitido", async () => {
  expect(isAllowedTransition("reservada", "recibida")).toBe(true);
  expect(isManualTransition("reservada", "recibida")).toBe(false);
  expect(isManualTransition("recibida", "diagnostico")).toBe(true);
  expect(isManualTransition("control_calidad", "lista_para_retirar")).toBe(false);
  expect(isAllowedTransition("entregada", "recibida")).toBe(false);
  const order = await create();
  const change = {
    branchId: owner.branchId,
    orderId: order.orderId,
    from: "reservada",
    to: "entregada",
    actorUserId: owner.id,
  } as const;
  expect(await recordStatusChange(test.db, change, NOW)).toEqual({
    ok: false,
    code: "invalid_transition",
  });
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(1);
  expect(
    await recordStatusChange(
      test.db,
      { ...change, to: "recibida", note: "Recepción completa" },
      NOW,
    ),
  ).toEqual({ ok: true });
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(2);
  const history = await test.db
    .select()
    .from(workOrderStatusHistory)
    .where(eq(workOrderStatusHistory.fromStatus, "reservada"));
  expect(history[0]).toMatchObject({
    toStatus: "recibida",
    actorUserId: owner.id,
    note: "Recepción completa",
  });
});
