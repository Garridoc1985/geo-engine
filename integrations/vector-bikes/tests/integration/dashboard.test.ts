import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { payments, workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { bookings, branches, users } from "../../src/server/db/schema.ts";
import { adminDashboard, mechanicDashboard } from "../../src/server/taller/dashboard.ts";
import { ORDER_STATUSES } from "../../src/server/taller/rules.ts";
import type { OrderStatus } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

// En Santiago aún es el 8 de octubre, aunque UTC ya esté en el día siguiente.
const NOW = new Date("2026-10-09T01:00:00.000Z");
const TODAY = "2026-10-08";
const EXPECTED_LOAD = [
  "reservada",
  "recibida",
  "diagnostico",
  "esperando_aprobacion",
  "esperando_repuesto",
  "en_reparacion",
  "control_calidad",
] as const;
const EXPECTED_SOON = [
  "reservada",
  "diagnostico",
  "esperando_aprobacion",
  "esperando_repuesto",
  "control_calidad",
] as const;
const DATES: Record<OrderStatus, string> = {
  reservada: TODAY,
  recibida: "2026-10-07",
  diagnostico: TODAY,
  esperando_aprobacion: "2026-10-09",
  esperando_repuesto: "2026-10-10",
  en_reparacion: "2026-10-11",
  control_calidad: TODAY,
  lista_para_retirar: "2026-10-07",
  entregada: "2026-10-07",
  cancelada: "2026-10-07",
  trabajo_rechazado: "2026-10-07",
};
type Identity = { owner: SessionUser; customerId: string; bikeId: string };
type Order = typeof workOrders.$inferSelect;
type StatusOrders = Record<OrderStatus, Order>;
let test: TestDb;
let identity: Identity;
let mechanic: SessionUser;
let otherMechanic: SessionUser;
let idleMechanic: SessionUser;
let inactiveMechanic: SessionUser;
let foreign: Identity;
let assigned: StatusOrders;
let unassigned: StatusOrders;
let others: StatusOrders;
let foreignOrders: StatusOrders;
let voided: StatusOrders;
let undated: Order;
let paidReady: Order;
let inactiveOrder: Order;
let number: number;

async function staff(
  branchId: string,
  role: SessionUser["role"],
  isActive = true,
): Promise<SessionUser> {
  const [row] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      isActive,
      name: `${role} ${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
    })
    .returning();
  if (!row) throw new Error("Falta el usuario.");
  return { id: row.id, branchId, role, name: row.name, email: row.email };
}

async function seedIdentity(rut: string | null = "12345678-5"): Promise<Identity> {
  const [branch] = await test.db
    .insert(branches)
    .values({ name: `Sucursal ${randomUUID()}` })
    .returning();
  if (!branch) throw new Error("Falta la sucursal.");
  const owner = await staff(branch.id, "owner");
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: branch.id,
      name: "Ana Pérez",
      phoneE164: "+56912345678",
      email: "ana@example.test",
      rut,
    })
    .returning();
  if (!customer) throw new Error("Falta el cliente.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: branch.id,
      customerId: customer.id,
      brand: "Trek",
      model: "Marlin",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta.");
  return { owner, customerId: customer.id, bikeId: bike.id };
}

async function createOrder(
  overrides: Partial<typeof workOrders.$inferInsert> = {},
  target = identity,
) {
  const [row] = await test.db
    .insert(workOrders)
    .values({
      branchId: target.owner.branchId,
      customerId: target.customerId,
      bikeId: target.bikeId,
      createdBy: target.owner.id,
      number: ++number,
      requestedService: "Mantención",
      status: "recibida",
      estimatedDeliveryDate: TODAY,
      estimatedMinutes: 30,
      totalClp: 20000,
      paidClp: 0,
      qcApprovedAt: NOW,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("Falta la orden.");
  return row;
}

async function seedStatuses(
  assignedMechanicId: string | null,
  target = identity,
  voidedAt: Date | null = null,
) {
  const rows = {} as StatusOrders;
  for (const status of ORDER_STATUSES) {
    rows[status] = await createOrder(
      {
        status,
        assignedMechanicId,
        voidedAt,
        estimatedDeliveryDate: DATES[status],
        paidClp: status === "entregada" ? 20000 : 0,
      },
      target,
    );
  }
  return rows;
}

beforeEach(async () => {
  test = await createTestDb();
  number = 0;
  identity = await seedIdentity();
  mechanic = await staff(identity.owner.branchId, "mechanic");
  otherMechanic = await staff(identity.owner.branchId, "mechanic");
  idleMechanic = await staff(identity.owner.branchId, "mechanic");
  inactiveMechanic = await staff(identity.owner.branchId, "mechanic", false);
  foreign = await seedIdentity(null);
  assigned = await seedStatuses(mechanic.id);
  unassigned = await seedStatuses(null);
  others = await seedStatuses(otherMechanic.id);
  foreignOrders = await seedStatuses(mechanic.id, foreign);
  voided = await seedStatuses(mechanic.id, identity, NOW);
  undated = await createOrder({
    assignedMechanicId: mechanic.id,
    estimatedDeliveryDate: null,
    estimatedMinutes: 45,
  });
  paidReady = await createOrder({
    status: "lista_para_retirar",
    assignedMechanicId: mechanic.id,
    paidClp: 20000,
  });
  inactiveOrder = await createOrder({ assignedMechanicId: inactiveMechanic.id });
  return () => test.close();
});

function expectIds(actual: { id: string }[], expected: { id: string }[]) {
  expect(actual.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort());
}

function statusRows(rows: StatusOrders, statuses: readonly OrderStatus[]) {
  return statuses.map((status) => rows[status]);
}

function expectPrivateDataAbsent(value: unknown) {
  const json = JSON.stringify(value);
  for (const field of ["phone", "email", "rut", "+56912345678", "ana@example.test", "12345678-5"])
    expect(json).not.toContain(field);
}

async function admin() {
  const result = await adminDashboard(test.db, identity.owner, NOW);
  if (!result) throw new Error("Falta el dashboard de administración.");
  return result;
}

async function mine() {
  const result = await mechanicDashboard(test.db, mechanic, NOW);
  if (!result) throw new Error("Falta el dashboard del mecánico.");
  return result;
}

it("1: agrupa por estado y excluye órdenes anuladas y de otra sucursal", async () => {
  const dashboard = await admin();
  for (const [group, status] of [
    ["waitingApproval", "esperando_aprobacion"],
    ["waitingParts", "esperando_repuesto"],
    ["inRepair", "en_reparacion"],
    ["qcPending", "control_calidad"],
    ["readyForPickup", "lista_para_retirar"],
  ] as const) {
    const expected = [assigned[status], unassigned[status], others[status]];
    if (status === "lista_para_retirar") expected.push(paidReady);
    expectIds(dashboard[group], expected);
  }
  const workshop: OrderStatus[] = [...EXPECTED_LOAD.slice(1), "lista_para_retirar"];
  expectIds(dashboard.inWorkshop, [
    ...workshop.flatMap((status) => [assigned[status], unassigned[status], others[status]]),
    undated,
    paidReady,
    inactiveOrder,
  ]);
  expect(dashboard.inWorkshop.find((row) => row.id === assigned.recibida.id)).toEqual({
    id: assigned.recibida.id,
    number: "OT-00002",
    customerName: "Ana Pérez",
    bike: "Trek Marlin",
    status: "recibida",
    statusLabel: "Recibida",
    mechanicName: mechanic.name,
    estimatedDeliveryDate: "2026-10-07",
  });
});

it("2: atraso abierto, fechas próximas inclusivas y saldo pendiente por id", async () => {
  const dashboard = await admin();
  expectIds(dashboard.overdue, [
    assigned.recibida,
    unassigned.recibida,
    others.recibida,
    assigned.lista_para_retirar,
    unassigned.lista_para_retirar,
    others.lista_para_retirar,
  ]);
  expectIds(dashboard.upcomingDeliveries, [
    ...EXPECTED_SOON.flatMap((status) => [assigned[status], unassigned[status], others[status]]),
    inactiveOrder,
  ]);
  const pending = dashboard.pendingPayments ?? [];
  const ready = [assigned, unassigned, others].map((group) => group.lista_para_retirar);
  expectIds(pending, ready);
  expect(pending.map((row) => row.balance)).toEqual([20000, 20000, 20000]);
  expect(dashboard.overdue.some((row) => row.id === assigned.entregada.id)).toBe(false);
});

async function payment(
  receivedAt: string,
  amountClp: number,
  overrides: Partial<typeof payments.$inferInsert> = {},
) {
  await test.db.insert(payments).values({
    branchId: identity.owner.branchId,
    workOrderId: assigned.recibida.id,
    kind: "final",
    method: "efectivo",
    amountClp,
    receivedBy: identity.owner.id,
    receivedAt: new Date(receivedAt),
    ...overrides,
  });
}

it("3: suma solo pagos del día local, con inicio incluido y fin excluido", async () => {
  await payment("2026-10-08T03:00:00.000Z", 12000);
  await payment("2026-10-09T02:59:59.999Z", 8000);
  await payment("2026-10-08T15:00:00.000Z", 9000, { voidedAt: NOW });
  await payment("2026-10-08T02:59:59.999Z", 7000);
  await payment("2026-10-09T03:00:00.000Z", 6000);
  await payment("2026-10-08T16:00:00.000Z", 5000, {
    branchId: foreign.owner.branchId,
    workOrderId: foreignOrders.recibida.id,
  });
  await payment("2026-10-08T16:00:00.000Z", 4000, { workOrderId: voided.recibida.id });
  expect((await admin()).incomeTodayClp).toBe(12000 + 8000);
});

it("4: todos los grupos asignados pertenecen al actor y sin asignar usa el conjunto permitido", async () => {
  const dashboard = await mine();
  expectIds(dashboard.assigned, [...statusRows(assigned, EXPECTED_LOAD), undated]);
  expectIds(dashboard.pending, [
    assigned.recibida,
    assigned.diagnostico,
    assigned.en_reparacion,
    undated,
  ]);
  expectIds(dashboard.overdue, [assigned.recibida, assigned.lista_para_retirar]);
  expectIds(dashboard.waitingApproval, [assigned.esperando_aprobacion]);
  expectIds(dashboard.waitingParts, [assigned.esperando_repuesto]);
  expectIds(dashboard.qcPending, [assigned.control_calidad]);
  expectIds(dashboard.dueSoon, statusRows(assigned, EXPECTED_SOON));
  expectIds(dashboard.unassigned, [
    unassigned.reservada,
    unassigned.recibida,
    unassigned.diagnostico,
  ]);
  expectPrivateDataAbsent(dashboard);
});

it("cuenta carga y minutos desde las órdenes y conserva mecánicos activos sin carga", async () => {
  const dashboard = await admin();
  const expected = [...statusRows(assigned, EXPECTED_LOAD), undated];
  expect(dashboard.loadByMechanic.find((load) => load.mechanicId === mechanic.id)).toEqual({
    mechanicId: mechanic.id,
    name: mechanic.name,
    openOrders: expected.length,
    minutes: expected.reduce((minutes, order) => minutes + order.estimatedMinutes, 0),
  });
  expect(dashboard.loadByMechanic.find((load) => load.mechanicId === idleMechanic.id)).toEqual({
    mechanicId: idleMechanic.id,
    name: idleMechanic.name,
    openOrders: 0,
    minutes: 0,
  });
  expect(dashboard.loadByMechanic.map((load) => load.mechanicId).sort()).toEqual(
    [mechanic.id, otherMechanic.id, idleMechanic.id].sort(),
  );
});

async function booking(serviceDate: string, status: string) {
  const [row] = await test.db
    .insert(bookings)
    .values({
      code: randomUUID(),
      cancelTokenHash: randomUUID(),
      serviceDate,
      status,
      mode: "taller",
      startsAt: new Date(`${serviceDate}T18:00:00.000Z`),
      endsAt: new Date(`${serviceDate}T18:30:00.000Z`),
      customerName: "Ana María Pérez",
      phoneE164: "+56912345678",
      email: "ana@example.test",
      bike: "Trek Marlin",
      description: "Mantención general",
      consentAt: NOW,
    })
    .returning();
  if (!row) throw new Error("Falta la reserva.");
  return row;
}

it("reservas activas de hoy y próximos dos días, sin datos de contacto", async () => {
  await booking(TODAY, "confirmed");
  await booking("2026-10-09", "ready_for_pickup");
  await booking("2026-10-10", "confirmed");
  for (const status of ["cancelled", "completed", "no_show"]) await booking(TODAY, status);
  await booking("2026-10-07", "confirmed");
  await booking("2026-10-11", "confirmed");
  expect((await admin()).bookingsToday).toEqual([
    {
      serviceDate: TODAY,
      time: "15:00",
      customerName: "Ana María Pérez",
      service: "Mantención general",
    },
  ]);
  const intakes = (await mine()).upcomingIntakes;
  expect(intakes).toEqual(
    [TODAY, "2026-10-09", "2026-10-10"].map((serviceDate) => ({
      serviceDate,
      time: "15:00",
      customerFirstName: "Ana",
      service: "Mantención general",
    })),
  );
  expectPrivateDataAbsent(intakes);
});

it("rechaza el dashboard del otro rol antes de consultar", async () => {
  expect(await adminDashboard(test.db, mechanic, NOW)).toBeNull();
  expect(await mechanicDashboard(test.db, identity.owner, NOW)).toBeNull();
});
