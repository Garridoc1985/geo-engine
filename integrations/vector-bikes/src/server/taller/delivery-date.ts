import { and, eq, gte, lte, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { addDays, calendarClosure, localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { workOrders } from "../db/schema-orders.ts";
import { recordAudit } from "./audit.ts";
import { getOrderHeader } from "./orders.ts";
import { LOAD_EXCLUDED_STATUSES, WORKSHOP_MINUTES_PER_DAY } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export const deliveryDateSchema = z.iso.date({ error: "Ingresa una fecha de entrega válida." });

type SuggestionInput = {
  now: Date;
  orderMinutes: number;
  loadByDate: ReadonlyMap<string, number>;
  capacityMinutes?: number;
  isBusinessDay?: (date: string) => boolean;
  horizonDays?: number;
};

export function suggestDeliveryDate({
  now,
  orderMinutes,
  loadByDate,
  capacityMinutes = WORKSHOP_MINUTES_PER_DAY,
  isBusinessDay = (date) => calendarClosure(date, []) === null,
  horizonDays = 60,
}: SuggestionInput): string {
  const today = localToday(now);
  let date = addDays(today, 1);
  for (let day = 1; day <= horizonDays; day++) {
    date = addDays(today, day);
    const load = loadByDate.get(date) ?? 0;
    if (
      isBusinessDay(date) &&
      (orderMinutes > capacityMinutes ? load === 0 : load + orderMinutes <= capacityMinutes)
    ) {
      return date;
    }
  }
  return date;
}

export async function loadByDate(
  db: AppDb,
  branchId: string,
  from: string,
  to: string,
  excludeOrderId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      date: workOrders.estimatedDeliveryDate,
      minutes: sql<number>`sum(estimated_minutes)`.mapWith(Number),
    })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.branchId, branchId),
        gte(workOrders.estimatedDeliveryDate, from),
        lte(workOrders.estimatedDeliveryDate, to),
        ne(workOrders.id, excludeOrderId),
        notInArray(workOrders.status, [...LOAD_EXCLUDED_STATUSES]),
      ),
    )
    .groupBy(workOrders.estimatedDeliveryDate);
  return new Map(
    rows.flatMap((row) => (row.date === null ? [] : [[row.date, row.minutes] as const])),
  );
}

async function lockAccessibleOrder(db: AppDb, actor: SessionUser, orderId: string) {
  await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)))
    .for("update");
  const header = await getOrderHeader(db, actor, orderId);
  if (!header) return { ok: false, code: "not_found" } as const;
  const { order } = header;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  return { ok: true } as const;
}

export async function confirmDeliveryDate(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  date: string,
  now: Date,
) {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" } as const;
  if (!deliveryDateSchema.safeParse(date).success || date < localToday(now))
    return { ok: false, code: "invalid_date" } as const;
  return db.transaction(async (tx) => {
    const access = await lockAccessibleOrder(tx, actor, orderId);
    if (!access.ok) return access;
    await tx
      .update(workOrders)
      .set({
        estimatedDeliveryDate: date,
        deliveryDateConfirmedAt: now,
        updatedAt: now,
      })
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)));
    await recordAudit(
      tx,
      {
        branchId: actor.branchId,
        actorUserId: actor.id,
        action: "order.delivery_date_confirmed",
        entity: "work_order",
        entityId: orderId,
        details: { date },
      },
      now,
    );
    return { ok: true } as const;
  });
}
