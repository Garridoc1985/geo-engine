import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { localToInstant } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import {
  bikeComponents,
  payments,
  workOrderApprovals,
  workOrderItems,
  workOrders,
} from "../db/schema-orders.ts";
import { serviceReports } from "../db/schema-reports.ts";
import { formatClp } from "../email/templates.ts";
import { getBike } from "./bikes.ts";
import { getCustomer } from "./customers.ts";
import { formatOrderNumber } from "./orders.ts";
import { PAYMENT_KIND_LABELS } from "./rules.ts";

export type TimelineEvent = {
  at: string;
  kind:
    | "order_opened"
    | "service_done"
    | "component_installed"
    | "component_replaced"
    | "approval_rejected"
    | "report_generated"
    | "payment"
    | "warranty_opened"
    | "order_delivered";
  orderId?: string;
  orderNumber?: string;
  title: string;
  detail?: string;
};

const KIND_ORDER: TimelineEvent["kind"][] = [
  "order_opened",
  "service_done",
  "component_installed",
  "component_replaced",
  "approval_rejected",
  "payment",
  "order_delivered",
  "report_generated",
  "warranty_opened",
];
const orderFields = {
  id: workOrders.id,
  number: workOrders.number,
  receivedAt: workOrders.receivedAt,
  createdAt: workOrders.createdAt,
  requestedService: workOrders.requestedService,
  deliveredAt: workOrders.deliveredAt,
  warrantyOfOrderId: workOrders.warrantyOfOrderId,
};
type HistoryOrder = {
  id: string;
  number: number;
  receivedAt: Date | null;
  createdAt: Date;
  requestedService: string;
};

export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

function dateAtNoon(date: string): string {
  // Solo se conoce el día: mediodía queda después de la apertura matinal y evita cambios de día por zona horaria.
  return localToInstant(date, "12:00")?.toISOString() ?? `${date}T12:00:00.000Z`;
}

function openedEvents(orders: HistoryOrder[]): TimelineEvent[] {
  return orders.map((order) => ({
    at: (order.receivedAt ?? order.createdAt).toISOString(),
    kind: "order_opened",
    orderId: order.id,
    title: "Orden abierta",
    detail: order.requestedService,
  }));
}

function finishTimeline(events: TimelineEvent[], orders: HistoryOrder[]): TimelineEvent[] {
  const numbers = new Map(orders.map((order) => [order.id, formatOrderNumber(order.number)]));
  return sortTimeline(
    events.map((event) => ({ ...event, orderNumber: numbers.get(event.orderId ?? "") })),
  );
}

async function serviceEvents(db: AppDb, actor: SessionUser, orderIds: string[]) {
  const rows = await db
    .select({
      orderId: workOrderItems.workOrderId,
      at: workOrderItems.createdAt,
      title: workOrderItems.description,
      quantity: workOrderItems.quantity,
    })
    .from(workOrderItems)
    .where(
      and(
        eq(workOrderItems.branchId, actor.branchId),
        inArray(workOrderItems.workOrderId, orderIds),
        isNull(workOrderItems.voidedAt),
      ),
    )
    .orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id));
  return rows.map(
    ({ at, quantity, ...row }): TimelineEvent => ({
      ...row,
      at: at.toISOString(),
      kind: "service_done",
      detail: `Cantidad: ${quantity}`,
    }),
  );
}

async function componentEvents(db: AppDb, actor: SessionUser, bikeId: string, orderIds: string[]) {
  const rows = await db
    .select({
      orderId: bikeComponents.workOrderId,
      componentType: bikeComponents.componentType,
      brand: bikeComponents.brand,
      model: bikeComponents.model,
      installedAt: bikeComponents.installedAt,
      replacedAt: bikeComponents.replacedAt,
    })
    .from(bikeComponents)
    .where(
      and(
        eq(bikeComponents.branchId, actor.branchId),
        eq(bikeComponents.bikeId, bikeId),
        inArray(bikeComponents.workOrderId, orderIds),
        isNull(bikeComponents.voidedAt),
      ),
    )
    .orderBy(asc(bikeComponents.createdAt), asc(bikeComponents.id));
  return rows.flatMap((row): TimelineEvent[] => {
    const fields = {
      orderId: row.orderId,
      title: `${row.componentType} ${row.brand} ${row.model}`,
    };
    const installed: TimelineEvent = {
      ...fields,
      at: dateAtNoon(row.installedAt),
      kind: "component_installed",
    };
    return row.replacedAt
      ? [installed, { ...fields, at: dateAtNoon(row.replacedAt), kind: "component_replaced" }]
      : [installed];
  });
}

async function rejectedEvents(db: AppDb, actor: SessionUser, orderIds: string[]) {
  const rows = await db
    .select({
      orderId: workOrderApprovals.workOrderId,
      at: workOrderApprovals.decidedAt,
      title: workOrderApprovals.description,
      detail: workOrderApprovals.recommendation,
    })
    .from(workOrderApprovals)
    .where(
      and(
        eq(workOrderApprovals.branchId, actor.branchId),
        inArray(workOrderApprovals.workOrderId, orderIds),
        eq(workOrderApprovals.decision, "rechazado"),
        isNull(workOrderApprovals.voidedAt),
      ),
    )
    .orderBy(asc(workOrderApprovals.decidedAt), asc(workOrderApprovals.id));
  return rows.flatMap(({ at, ...row }): TimelineEvent[] =>
    at ? [{ ...row, at: at.toISOString(), kind: "approval_rejected" }] : [],
  );
}

async function reportEvents(db: AppDb, actor: SessionUser, orderIds: string[]) {
  const rows = await db
    .select({ orderId: serviceReports.workOrderId, at: serviceReports.generatedAt })
    .from(serviceReports)
    .where(
      and(
        eq(serviceReports.branchId, actor.branchId),
        inArray(serviceReports.workOrderId, orderIds),
      ),
    )
    .orderBy(asc(serviceReports.generatedAt), asc(serviceReports.id));
  return rows.map(
    ({ at, orderId }): TimelineEvent => ({
      orderId,
      at: at.toISOString(),
      kind: "report_generated",
      title: "Informe generado",
    }),
  );
}

export async function bikeTimeline(
  db: AppDb,
  actor: SessionUser,
  bikeId: string,
): Promise<TimelineEvent[]> {
  if (!can(actor.role, "customers.manage") || !z.uuid().safeParse(bikeId).success) return [];
  if (!(await getBike(db, actor, bikeId))) return [];
  const orders = await db
    .select(orderFields)
    .from(workOrders)
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        eq(workOrders.bikeId, bikeId),
        isNull(workOrders.voidedAt),
      ),
    )
    .orderBy(asc(workOrders.createdAt), asc(workOrders.id));
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const batches = await Promise.all([
    serviceEvents(db, actor, ids),
    componentEvents(db, actor, bikeId, ids),
    rejectedEvents(db, actor, ids),
    reportEvents(db, actor, ids),
  ]);
  return finishTimeline([...openedEvents(orders), ...batches.flat()], orders);
}

async function customerOrders(db: AppDb, actor: SessionUser, customerId: string) {
  const original = alias(workOrders, "warranty_original");
  return db
    .select({ ...orderFields, originalNumber: original.number })
    .from(workOrders)
    .leftJoin(
      original,
      and(eq(original.id, workOrders.warrantyOfOrderId), eq(original.branchId, actor.branchId)),
    )
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        eq(workOrders.customerId, customerId),
        isNull(workOrders.voidedAt),
      ),
    )
    .orderBy(asc(workOrders.createdAt), asc(workOrders.id));
}

async function paymentEvents(db: AppDb, actor: SessionUser, orderIds: string[]) {
  const rows = await db
    .select({
      orderId: payments.workOrderId,
      at: payments.receivedAt,
      kind: payments.kind,
      amountClp: payments.amountClp,
    })
    .from(payments)
    .where(
      and(
        eq(payments.branchId, actor.branchId),
        inArray(payments.workOrderId, orderIds),
        isNull(payments.voidedAt),
      ),
    )
    .orderBy(asc(payments.receivedAt), asc(payments.id));
  return rows.map(
    (row): TimelineEvent => ({
      orderId: row.orderId,
      at: row.at.toISOString(),
      kind: "payment",
      title: PAYMENT_KIND_LABELS[row.kind],
      detail: formatClp(row.amountClp),
    }),
  );
}

export async function customerTimeline(
  db: AppDb,
  actor: SessionUser,
  customerId: string,
): Promise<TimelineEvent[]> {
  if (!can(actor.role, "customers.manage") || !z.uuid().safeParse(customerId).success) return [];
  if (!(await getCustomer(db, actor, customerId))) return [];
  const orders = await customerOrders(db, actor, customerId);
  if (!orders.length) return [];
  const events = openedEvents(orders);
  events.push(
    ...(await paymentEvents(
      db,
      actor,
      orders.map((order) => order.id),
    )),
  );
  for (const order of orders) {
    if (order.warrantyOfOrderId)
      events.push({
        at: order.createdAt.toISOString(),
        kind: "warranty_opened",
        orderId: order.id,
        title: "Garantía abierta",
        detail:
          order.originalNumber === null
            ? "Garantía de una orden anterior"
            : `Garantía de ${formatOrderNumber(order.originalNumber)}`,
      });
    if (order.deliveredAt)
      events.push({
        at: order.deliveredAt.toISOString(),
        kind: "order_delivered",
        orderId: order.id,
        title: "Orden entregada",
      });
  }
  return finishTimeline(events, orders);
}
