import { and, asc, eq, isNull, lt, notInArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { getEmailEnv } from "../../lib/env.ts";
import { log } from "../../lib/log.ts";
import { TIMEZONE } from "../booking/rules.ts";
import { localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { orderPhotos, workOrders } from "../db/schema-orders.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { escapeHtml } from "../email/templates.ts";
import { createTransport } from "../email/transport.ts";
import type { EmailTransport } from "../email/transport.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import { formatOrderNumber } from "./orders.ts";
import { TERMINAL_STATUSES } from "./rules.ts";

export async function overdueOrders(db: AppDb, now: Date) {
  const today = localToday(now);
  const rows = await db
    .select({
      number: workOrders.number,
      customerName: customers.name,
      brand: bikes.brand,
      model: bikes.model,
      estimatedDeliveryDate: workOrders.estimatedDeliveryDate,
    })
    .from(workOrders)
    .innerJoin(customers, eq(customers.id, workOrders.customerId))
    .innerJoin(bikes, eq(bikes.id, workOrders.bikeId))
    .where(
      and(
        isNull(workOrders.voidedAt),
        lt(workOrders.estimatedDeliveryDate, today),
        notInArray(workOrders.status, [...TERMINAL_STATUSES]),
      ),
    )
    .orderBy(asc(workOrders.estimatedDeliveryDate), asc(workOrders.number));
  const localDay = DateTime.fromISO(today, { zone: TIMEZONE });
  return rows.map((row) => {
    if (!row.estimatedDeliveryDate) throw new Error("Falta la fecha prometida.");
    const promised = DateTime.fromISO(row.estimatedDeliveryDate, { zone: TIMEZONE });
    return {
      number: formatOrderNumber(row.number),
      customerName: row.customerName,
      bike: `${row.brand} ${row.model}`.trim(),
      estimatedDeliveryDate: row.estimatedDeliveryDate,
      daysLate: Math.round(localDay.diff(promised, "days").days),
    };
  });
}

/** Conserva el conteo del resumen aunque el transporte rechace el envío. */
export class OverdueDigestError extends Error {
  readonly overdue: number;

  constructor(overdue: number, cause: unknown) {
    super("Falló el envío del resumen de órdenes atrasadas.", { cause });
    this.name = "OverdueDigestError";
    this.overdue = overdue;
  }
}

export async function sendOverdueDigest(
  db: AppDb,
  now: Date,
  deps: { transport?: EmailTransport } = {},
): Promise<{ overdue: number; sent: boolean }> {
  const orders = await overdueOrders(db, now);
  if (orders.length === 0) return { overdue: 0, sent: false };
  const lines = orders.map((order) => {
    const date = DateTime.fromISO(order.estimatedDeliveryDate, { zone: TIMEZONE });
    return `${order.number} · ${order.customerName} · ${order.bike} · prometida ${date.toFormat("dd-MM-yyyy")} (${order.daysLate} días)`;
  });
  try {
    await (deps.transport ?? createTransport()).send({
      to: getEmailEnv().SHOP_NOTIFY_EMAIL,
      subject: `Órdenes atrasadas: ${orders.length} · Vector Bikes`,
      text: lines.join("\n"),
      html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n"),
    });
  } catch (error) {
    throw new OverdueDigestError(orders.length, error);
  }
  return { overdue: orders.length, sent: true };
}

/**
 * El driver de Replit falla al borrar un objeto que ya no existe: si el borrado falla y la copia
 * completa ya no está, cuenta como purgada para no reintentarla (y responder 500) cada día.
 */
async function deleteFullCopy(storage: ObjectStorage, fullKey: string) {
  try {
    await storage.delete(fullKey);
  } catch (error) {
    if (await storage.exists(fullKey)) throw error;
  }
}

export async function purgeReceptionPhotos(db: AppDb, storage: ObjectStorage, now: Date) {
  const cutoff = DateTime.fromJSDate(now).setZone(TIMEZONE).minus({ months: 6 }).toJSDate();
  const photos = await db
    .select({ id: orderPhotos.id, fullKey: orderPhotos.fullKey })
    .from(orderPhotos)
    .where(
      and(
        eq(orderPhotos.stage, "recepcion"),
        eq(orderPhotos.retentionClass, "recepcion_6m"),
        isNull(orderPhotos.fullPurgedAt),
        lt(orderPhotos.createdAt, cutoff),
      ),
    );
  let purged = 0;
  let failed = 0;
  for (const photo of photos) {
    try {
      await deleteFullCopy(storage, photo.fullKey);
      const marked = await db
        .update(orderPhotos)
        .set({ fullPurgedAt: now, updatedAt: now })
        .where(and(eq(orderPhotos.id, photo.id), isNull(orderPhotos.fullPurgedAt)))
        .returning({ id: orderPhotos.id });
      purged += marked.length;
    } catch {
      failed += 1;
      log.error("tasks.retention_photo_failed");
    }
  }
  return { purged, failed };
}
