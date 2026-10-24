import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { workOrderItems, workOrders } from "../db/schema-orders.ts";
import { recordAudit } from "./audit.ts";
import { getService, priceFor } from "./catalog.ts";
import { getOrderHeader } from "./orders.ts";
import type { BikeType } from "./rules.ts";
import { TERMINAL_STATUSES } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export const catalogItemSchema = z.strictObject({
  serviceId: z.uuid({ error: "Selecciona un servicio del catálogo." }),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  origin: z.enum(["inicial", "adicional"]).default("inicial"),
});

const itemPriceSchema = z
  .union([z.number(), z.string().trim().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().min(0).max(10_000_000));
export const partItemSchema = z.strictObject({
  description: z.string().trim().min(2).max(200),
  quantity: z.coerce.number().int().min(1).max(100),
  unitPriceClp: itemPriceSchema,
});
export const priceOverrideSchema = z.strictObject({ unitPriceClp: itemPriceSchema });

async function accessibleOrder(db: AppDb, actor: SessionUser, orderId: string) {
  const header = await getOrderHeader(db, actor, orderId);
  if (!header || header.order.voidedAt) return { ok: false, code: "not_found" } as const;
  const { order } = header;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  return { ok: true, ...header } as const;
}

async function lockOrder(db: AppDb, actor: SessionUser, orderId: string) {
  await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)))
    .for("update");
  const access = await accessibleOrder(db, actor, orderId);
  if (!access.ok) return access;
  if ((TERMINAL_STATUSES as readonly string[]).includes(access.order.status))
    return { ok: false, code: "invalid_status" } as const;
  return access;
}

/** Recibe la misma transacción que agrega, cambia o anula la línea. */
export async function recomputeOrderTotals(db: AppDb, orderId: string, now: Date) {
  const [order] = await db
    .select({ branchId: workOrders.branchId })
    .from(workOrders)
    .where(eq(workOrders.id, orderId))
    .limit(1);
  if (!order) return;
  const [totals] = await db
    .select({
      totalClp: sql<number>`coalesce(sum(quantity * unit_price_clp), 0)`.mapWith(Number),
      estimatedMinutes: sql<number>`coalesce(sum(quantity * estimated_minutes), 0)`.mapWith(Number),
    })
    .from(workOrderItems)
    .where(
      and(
        eq(workOrderItems.branchId, order.branchId),
        eq(workOrderItems.workOrderId, orderId),
        isNull(workOrderItems.voidedAt),
      ),
    );
  if (!totals) throw new Error("No se pudieron calcular los totales.");
  await db
    .update(workOrders)
    .set({ ...totals, updatedAt: now })
    .where(and(eq(workOrders.branchId, order.branchId), eq(workOrders.id, orderId)));
}

async function insertCatalogItem(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: z.infer<typeof catalogItemSchema>,
  bikeType: BikeType,
  now: Date,
) {
  const service = await getService(db, actor, input.serviceId);
  if (!service) return { ok: false, code: "not_found" } as const;
  const unitPriceClp = await priceFor(db, actor, input.serviceId, bikeType);
  if (unitPriceClp === null) return { ok: false, code: "no_price" } as const;
  const [item] = await db
    .insert(workOrderItems)
    .values({
      ...input,
      branchId: actor.branchId,
      workOrderId: orderId,
      kind: "servicio",
      description: service.name,
      unitPriceClp,
      estimatedMinutes: service.estimatedMinutes,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!item) throw new Error("No se pudo agregar el servicio.");
  await recomputeOrderTotals(db, orderId, now);
  await auditAddedItem(db, actor, item, now);
  return { ok: true, itemId: item.id } as const;
}

async function auditAddedItem(
  db: AppDb,
  actor: SessionUser,
  item: typeof workOrderItems.$inferSelect,
  now: Date,
) {
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: "item.added",
      entity: "work_order",
      entityId: item.workOrderId,
      details: {
        itemId: item.id,
        kind: item.kind,
        origin: item.origin,
        ...(item.kind === "servicio" ? { serviceId: item.serviceId } : {}),
        quantity: item.quantity,
        unitPriceClp: item.unitPriceClp,
      },
    },
    now,
  );
}

export async function addCatalogItem(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "items.add_catalog")) return { ok: false, code: "forbidden" } as const;
  const parsed = catalogItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, orderId);
    if (!access.ok) return access;
    return insertCatalogItem(
      tx,
      actor,
      orderId,
      parsed.data,
      access.bike.bikeType as BikeType,
      now,
    );
  });
}

export async function addPartItem(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "items.add_part")) return { ok: false, code: "forbidden" } as const;
  const parsed = partItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, orderId);
    if (!access.ok) return access;
    const [item] = await tx
      .insert(workOrderItems)
      .values({
        ...parsed.data,
        branchId: actor.branchId,
        workOrderId: orderId,
        kind: "repuesto",
        origin: "inicial",
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!item) throw new Error("No se pudo agregar el repuesto.");
    await recomputeOrderTotals(tx, orderId, now);
    await auditAddedItem(tx, actor, item, now);
    return { ok: true, itemId: item.id } as const;
  });
}

async function lockActiveItem(db: AppDb, actor: SessionUser, itemId: string) {
  const scope = and(eq(workOrderItems.branchId, actor.branchId), eq(workOrderItems.id, itemId));
  const [reference] = await db
    .select({ orderId: workOrderItems.workOrderId })
    .from(workOrderItems)
    .where(and(scope, isNull(workOrderItems.voidedAt)))
    .limit(1);
  if (!reference) return { ok: false, code: "not_found" } as const;
  const access = await lockOrder(db, actor, reference.orderId);
  if (!access.ok) return access;
  const [item] = await db
    .select()
    .from(workOrderItems)
    .where(and(scope, isNull(workOrderItems.voidedAt)))
    .for("update");
  if (!item) return { ok: false, code: "not_found" } as const;
  return { ok: true, item } as const;
}

export async function overrideItemPrice(
  db: AppDb,
  actor: SessionUser,
  itemId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "items.override_price")) return { ok: false, code: "forbidden" } as const;
  const parsed = priceOverrideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockActiveItem(tx, actor, itemId);
    if (!access.ok) return access;
    const { item } = access;
    await tx
      .update(workOrderItems)
      .set({ unitPriceClp: parsed.data.unitPriceClp, updatedAt: now })
      .where(and(eq(workOrderItems.branchId, actor.branchId), eq(workOrderItems.id, itemId)));
    await recomputeOrderTotals(tx, item.workOrderId, now);
    await recordAudit(
      tx,
      {
        branchId: actor.branchId,
        actorUserId: actor.id,
        action: "item.price_changed",
        entity: "work_order",
        entityId: item.workOrderId,
        details: { itemId, before: item.unitPriceClp, after: parsed.data.unitPriceClp },
      },
      now,
    );
    return { ok: true } as const;
  });
}

export async function voidItem(db: AppDb, actor: SessionUser, itemId: string, now: Date) {
  if (!can(actor.role, "items.void")) return { ok: false, code: "forbidden" } as const;
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(workOrderItems)
      .where(and(eq(workOrderItems.branchId, actor.branchId), eq(workOrderItems.id, itemId)))
      .limit(1);
    if (!item) return { ok: false, code: "not_found" } as const;
    const access = await lockOrder(tx, actor, item.workOrderId);
    if (!access.ok) return access;
    const changed = await tx
      .update(workOrderItems)
      .set({ voidedAt: now, voidedBy: actor.id, updatedAt: now })
      .where(
        and(
          eq(workOrderItems.branchId, actor.branchId),
          eq(workOrderItems.id, itemId),
          isNull(workOrderItems.voidedAt),
        ),
      )
      .returning({ id: workOrderItems.id });
    if (changed.length > 0) {
      await recomputeOrderTotals(tx, item.workOrderId, now);
      await recordAudit(
        tx,
        {
          branchId: actor.branchId,
          actorUserId: actor.id,
          action: "item.voided",
          entity: "work_order",
          entityId: item.workOrderId,
          details: { itemId },
        },
        now,
      );
    }
    return { ok: true } as const;
  });
}

export async function listItems(db: AppDb, actor: SessionUser, orderId: string) {
  if (!(await accessibleOrder(db, actor, orderId)).ok) return [];
  return db
    .select()
    .from(workOrderItems)
    .where(
      and(
        eq(workOrderItems.branchId, actor.branchId),
        eq(workOrderItems.workOrderId, orderId),
        isNull(workOrderItems.voidedAt),
      ),
    )
    .orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id));
}
