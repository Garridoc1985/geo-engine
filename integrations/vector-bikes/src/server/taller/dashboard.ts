import {
  and,
  asc,
  between,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sum,
} from "drizzle-orm";
import { DateTime } from "luxon";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { TIMEZONE } from "../booking/rules.ts";
import { addDays, localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { payments, workOrders } from "../db/schema-orders.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { bookings, users } from "../db/schema.ts";
import { formatOrderNumber } from "./orders.ts";
import {
  LOAD_EXCLUDED_STATUSES,
  MECHANIC_UNASSIGNED_ACCESS_STATUSES,
  ORDER_STATUSES,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from "./rules.ts";
import type { OrderStatus } from "./rules.ts";

export type DashboardOrder = {
  id: string;
  number: string;
  customerName: string;
  bike: string;
  status: OrderStatus;
  statusLabel: string;
  mechanicName: string | null;
  estimatedDeliveryDate: string | null;
};

function orderScope(actor: SessionUser) {
  return and(
    eq(workOrders.branchId, actor.branchId),
    isNull(workOrders.voidedAt),
    // Ningún grupo muestra órdenes cerradas: no se carga el historial completo en cada visita.
    notInArray(workOrders.status, [...TERMINAL_STATUSES]),
    actor.role === "mechanic"
      ? or(
          eq(workOrders.assignedMechanicId, actor.id),
          and(
            isNull(workOrders.assignedMechanicId),
            inArray(workOrders.status, [...MECHANIC_UNASSIGNED_ACCESS_STATUSES]),
          ),
        )
      : undefined,
  );
}

async function dashboardOrders(db: AppDb, actor: SessionUser) {
  return db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      customerName: customers.name,
      brand: bikes.brand,
      model: bikes.model,
      status: workOrders.status,
      mechanicName: users.name,
      assignedMechanicId: workOrders.assignedMechanicId,
      estimatedDeliveryDate: workOrders.estimatedDeliveryDate,
      estimatedMinutes: workOrders.estimatedMinutes,
      totalClp: workOrders.totalClp,
      paidClp: workOrders.paidClp,
    })
    .from(workOrders)
    .innerJoin(
      customers,
      and(eq(customers.id, workOrders.customerId), eq(customers.branchId, actor.branchId)),
    )
    .innerJoin(bikes, and(eq(bikes.id, workOrders.bikeId), eq(bikes.branchId, actor.branchId)))
    .leftJoin(
      users,
      and(eq(users.id, workOrders.assignedMechanicId), eq(users.branchId, actor.branchId)),
    )
    .where(orderScope(actor))
    .orderBy(desc(workOrders.number));
}

type OrderRow = Awaited<ReturnType<typeof dashboardOrders>>[number];

function orderItem(row: OrderRow): DashboardOrder {
  const status = row.status as OrderStatus;
  return {
    id: row.id,
    number: formatOrderNumber(row.number),
    customerName: row.customerName,
    bike: `${row.brand} ${row.model}`.trim(),
    status,
    statusLabel: STATUS_LABELS[status],
    mechanicName: row.mechanicName,
    estimatedDeliveryDate: row.estimatedDeliveryDate,
  };
}

function hasLoad(row: OrderRow) {
  return !(LOAD_EXCLUDED_STATUSES as readonly string[]).includes(row.status);
}

function isOverdue(row: OrderRow, today: string) {
  return (
    !(TERMINAL_STATUSES as readonly string[]).includes(row.status) &&
    row.estimatedDeliveryDate !== null &&
    row.estimatedDeliveryDate < today
  );
}

function isDueSoon(row: OrderRow, today: string) {
  return (
    hasLoad(row) &&
    row.estimatedDeliveryDate !== null &&
    row.estimatedDeliveryDate >= today &&
    row.estimatedDeliveryDate <= addDays(today, 2)
  );
}

async function activeBookings(db: AppDb, from: string, to: string) {
  // Las reservas existentes no tienen branch_id. Mismo conjunto activo que create-booking/cancel-flow.
  const rows = await db
    .select({
      serviceDate: bookings.serviceDate,
      startsAt: bookings.startsAt,
      customerName: bookings.customerName,
      service: bookings.description,
    })
    .from(bookings)
    .where(
      and(
        between(bookings.serviceDate, from, to),
        inArray(bookings.status, ["confirmed", "ready_for_pickup"]),
      ),
    )
    .orderBy(asc(bookings.serviceDate), asc(bookings.startsAt), asc(bookings.id));
  return rows.map(({ startsAt, ...row }) => ({
    ...row,
    time: DateTime.fromJSDate(startsAt).setZone(TIMEZONE).toFormat("HH:mm"),
  }));
}

async function incomeToday(db: AppDb, actor: SessionUser, today: string) {
  const start = DateTime.fromISO(today, { zone: TIMEZONE }).startOf("day");
  const end = start.plus({ days: 1 }).startOf("day");
  const [row] = await db
    .select({ amount: sum(payments.amountClp) })
    .from(payments)
    .innerJoin(
      workOrders,
      and(
        eq(workOrders.id, payments.workOrderId),
        eq(workOrders.branchId, actor.branchId),
        isNull(workOrders.voidedAt),
      ),
    )
    .where(
      and(
        eq(payments.branchId, actor.branchId),
        isNull(payments.voidedAt),
        gte(payments.receivedAt, start.toJSDate()),
        lt(payments.receivedAt, end.toJSDate()),
      ),
    );
  return Number(row?.amount ?? 0);
}

async function mechanicLoad(db: AppDb, actor: SessionUser, orders: OrderRow[]) {
  const mechanics = await db
    .select({ mechanicId: users.id, name: users.name })
    .from(users)
    .where(
      and(eq(users.branchId, actor.branchId), eq(users.role, "mechanic"), eq(users.isActive, true)),
    )
    .orderBy(asc(users.name), asc(users.id));
  const loads = new Map<string, { openOrders: number; minutes: number }>();
  for (const order of orders) {
    if (!order.assignedMechanicId || !hasLoad(order)) continue;
    const load = loads.get(order.assignedMechanicId) ?? { openOrders: 0, minutes: 0 };
    load.openOrders += 1;
    load.minutes += order.estimatedMinutes;
    loads.set(order.assignedMechanicId, load);
  }
  return mechanics.map((mechanic) => ({
    ...mechanic,
    ...(loads.get(mechanic.mechanicId) ?? { openOrders: 0, minutes: 0 }),
  }));
}

function pendingPayments(orders: OrderRow[]) {
  return orders
    .filter((order) => order.status === "lista_para_retirar" && order.totalClp > order.paidClp)
    .map((order) => ({ ...orderItem(order), balance: order.totalClp - order.paidClp }));
}

/** Ingresos y saldos solo para dueño y administración; para recepción ni se consultan (`null`). */
export async function adminDashboard(db: AppDb, actor: SessionUser, now: Date) {
  if (!can(actor.role, "dashboard.admin")) return null;
  const today = localToday(now);
  const finance = can(actor.role, "dashboard.finance");
  const [orders, bookingsToday, incomeTodayClp] = await Promise.all([
    dashboardOrders(db, actor),
    activeBookings(db, today, today),
    finance ? incomeToday(db, actor, today) : null,
  ]);
  const workshopStatuses: readonly string[] = ORDER_STATUSES.slice(
    ORDER_STATUSES.indexOf("recibida"),
    ORDER_STATUSES.indexOf("lista_para_retirar") + 1,
  );
  const byStatus = (status: OrderStatus) =>
    orders.filter((order) => order.status === status).map(orderItem);
  return {
    bookingsToday,
    incomeTodayClp,
    inWorkshop: orders.filter((order) => workshopStatuses.includes(order.status)).map(orderItem),
    waitingApproval: byStatus("esperando_aprobacion"),
    waitingParts: byStatus("esperando_repuesto"),
    inRepair: byStatus("en_reparacion"),
    qcPending: byStatus("control_calidad"),
    readyForPickup: byStatus("lista_para_retirar"),
    overdue: orders.filter((order) => isOverdue(order, today)).map(orderItem),
    upcomingDeliveries: orders.filter((order) => isDueSoon(order, today)).map(orderItem),
    loadByMechanic: await mechanicLoad(db, actor, orders),
    pendingPayments: finance ? pendingPayments(orders) : null,
  };
}

export async function mechanicDashboard(db: AppDb, actor: SessionUser, now: Date) {
  if (!can(actor.role, "dashboard.mechanic")) return null;
  const today = localToday(now);
  const [orders, bookingsSoon] = await Promise.all([
    dashboardOrders(db, actor),
    activeBookings(db, today, addDays(today, 2)),
  ]);
  const assigned = orders.filter((order) => order.assignedMechanicId === actor.id);
  const byStatus = (status: OrderStatus) =>
    assigned.filter((order) => order.status === status).map(orderItem);
  return {
    upcomingIntakes: bookingsSoon.map(({ customerName, ...booking }) => ({
      ...booking,
      customerFirstName: customerName.trim().split(/\s+/)[0] ?? "",
    })),
    assigned: assigned.filter(hasLoad).map(orderItem),
    pending: assigned
      .filter((order) => ["recibida", "diagnostico", "en_reparacion"].includes(order.status))
      .map(orderItem),
    overdue: assigned.filter((order) => isOverdue(order, today)).map(orderItem),
    waitingApproval: byStatus("esperando_aprobacion"),
    waitingParts: byStatus("esperando_repuesto"),
    dueSoon: assigned.filter((order) => isDueSoon(order, today)).map(orderItem),
    qcPending: byStatus("control_calidad"),
    unassigned: orders
      .filter(
        (order) =>
          order.assignedMechanicId === null &&
          (MECHANIC_UNASSIGNED_ACCESS_STATUSES as readonly string[]).includes(order.status),
      )
      .map(orderItem),
  };
}
