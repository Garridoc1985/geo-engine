import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { bikeComponents, workOrderItems, workOrders } from "../db/schema-orders.ts";
import { recordAudit } from "./audit.ts";
import type { AuditAction } from "./audit.ts";
import { canAccessOrder } from "./status.ts";

const optionalUuid = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.uuid({ error: "Selecciona una opción válida." }).optional(),
);
export const componentFormSchema = z.strictObject({
  componentType: z
    .string({ error: "Escribe el tipo de componente." })
    .trim()
    .min(2, "El tipo debe tener al menos 2 caracteres.")
    .max(60, "El tipo no puede superar los 60 caracteres."),
  brand: z
    .string({ error: "Escribe la marca." })
    .trim()
    .min(1, "Escribe la marca.")
    .max(60, "La marca no puede superar los 60 caracteres."),
  model: z
    .string({ error: "Escribe el modelo." })
    .trim()
    .min(1, "Escribe el modelo.")
    .max(80, "El modelo no puede superar los 80 caracteres."),
  serialNumber: z
    .string({ error: "Escribe un número de serie válido." })
    .trim()
    .max(80, "La serie no puede superar los 80 caracteres.")
    .nullish()
    .transform((value) => value || null),
  workOrderItemId: optionalUuid,
  replacesComponentId: optionalUuid,
  installedAt: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.iso.date({ error: "Selecciona una fecha válida (AAAA-MM-DD)." }).optional(),
  ),
});
type ComponentInput = z.infer<typeof componentFormSchema> & { installedAt: string };

function componentFilter(actor: SessionUser, componentId: string) {
  return and(eq(bikeComponents.branchId, actor.branchId), eq(bikeComponents.id, componentId));
}

async function lockOrder(db: AppDb, actor: SessionUser, orderId: string) {
  const [order] = await db
    .select()
    .from(workOrders)
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        eq(workOrders.id, orderId),
        isNull(workOrders.voidedAt),
      ),
    )
    .for("update");
  if (!order) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  return { ok: true, order } as const;
}

async function componentPrice(db: AppDb, actor: SessionUser, orderId: string, itemId?: string) {
  if (!itemId) return { ok: true, priceClp: 0 } as const;
  const [item] = await db
    .select({ priceClp: workOrderItems.unitPriceClp })
    .from(workOrderItems)
    .where(
      and(
        eq(workOrderItems.branchId, actor.branchId),
        eq(workOrderItems.workOrderId, orderId),
        eq(workOrderItems.id, itemId),
        eq(workOrderItems.kind, "repuesto"),
        isNull(workOrderItems.voidedAt),
      ),
    );
  if (!item) return { ok: false, code: "invalid_item" } as const;
  return { ok: true, priceClp: item.priceClp } as const;
}

async function lockReplacement(
  db: AppDb,
  actor: SessionUser,
  bikeId: string,
  input: ComponentInput,
) {
  if (!input.replacesComponentId) return { ok: true } as const;
  const [previous] = await db
    .select({ installedAt: bikeComponents.installedAt })
    .from(bikeComponents)
    .where(
      and(
        componentFilter(actor, input.replacesComponentId),
        eq(bikeComponents.bikeId, bikeId),
        isNull(bikeComponents.voidedAt),
        isNull(bikeComponents.replacedAt),
      ),
    )
    .for("update");
  if (!previous || input.installedAt < previous.installedAt)
    return { ok: false, code: "invalid_replacement" } as const;
  return { ok: true } as const;
}

class InvalidReplacement extends Error {}

async function replaceComponent(
  db: AppDb,
  actor: SessionUser,
  bikeId: string,
  input: ComponentInput,
  id: string,
  now: Date,
) {
  if (!input.replacesComponentId) return;
  const changed = await db
    .update(bikeComponents)
    .set({
      replacedAt: input.installedAt,
      replacedByComponentId: id,
      updatedAt: now,
    })
    .where(
      and(
        componentFilter(actor, input.replacesComponentId),
        eq(bikeComponents.bikeId, bikeId),
        isNull(bikeComponents.replacedAt),
        isNull(bikeComponents.voidedAt),
      ),
    )
    .returning({ id: bikeComponents.id });
  // Lanzar revierte también el componente recién insertado.
  if (changed.length === 0) throw new InvalidReplacement();
}

async function auditComponent(
  db: AppDb,
  actor: SessionUser,
  id: string,
  action: AuditAction,
  details: Record<string, unknown>,
  now: Date,
) {
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action,
      entity: "bike_component",
      entityId: id,
      details,
    },
    now,
  );
}

async function insertComponent(
  db: AppDb,
  actor: SessionUser,
  order: typeof workOrders.$inferSelect,
  input: ComponentInput,
  priceClp: number,
  now: Date,
) {
  const { replacesComponentId, ...fields } = input;
  const [component] = await db
    .insert(bikeComponents)
    .values({
      ...fields,
      priceClp,
      branchId: actor.branchId,
      bikeId: order.bikeId,
      workOrderId: order.id,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: bikeComponents.id });
  if (!component) throw new Error("No se pudo instalar el componente.");
  await replaceComponent(db, actor, order.bikeId, input, component.id, now);
  await auditComponent(
    db,
    actor,
    component.id,
    "component.installed",
    {
      orderId: order.id,
      replacesComponentId,
    },
    now,
  );
  return { ok: true, id: component.id } as const;
}

export async function installComponent(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "components.manage")) return { ok: false, code: "forbidden" } as const;
  const parsed = componentFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const fields = { ...parsed.data, installedAt: parsed.data.installedAt ?? localToday(now) };
  try {
    return await db.transaction(async (tx) => {
      const access = await lockOrder(tx, actor, orderId);
      if (!access.ok) return access;
      const price = await componentPrice(tx, actor, orderId, fields.workOrderItemId);
      if (!price.ok) return price;
      const replacement = await lockReplacement(tx, actor, access.order.bikeId, fields);
      if (!replacement.ok) return replacement;
      return insertComponent(tx, actor, access.order, fields, price.priceClp, now);
    });
  } catch (error) {
    if (error instanceof InvalidReplacement)
      return { ok: false, code: "invalid_replacement" } as const;
    throw error;
  }
}

export async function voidComponent(db: AppDb, actor: SessionUser, componentId: string, now: Date) {
  if (!can(actor.role, "items.void")) return { ok: false, code: "forbidden" } as const;
  return db.transaction(async (tx) => {
    const [component] = await tx
      .select()
      .from(bikeComponents)
      .where(componentFilter(actor, componentId))
      .for("update");
    if (!component) return { ok: false, code: "not_found" } as const;
    if (component.voidedAt) return { ok: false, code: "already_voided" } as const;
    await tx
      .update(bikeComponents)
      .set({ voidedAt: now, voidedBy: actor.id, updatedAt: now })
      .where(componentFilter(actor, componentId));
    await auditComponent(
      tx,
      actor,
      componentId,
      "component.voided",
      {
        orderId: component.workOrderId,
      },
      now,
    );
    return { ok: true } as const;
  });
}

export async function listComponentsOfBike(db: AppDb, actor: SessionUser, bikeId: string) {
  return db
    .select({
      id: bikeComponents.id,
      componentType: bikeComponents.componentType,
      brand: bikeComponents.brand,
      model: bikeComponents.model,
      serialNumber: bikeComponents.serialNumber,
      installedAt: bikeComponents.installedAt,
      priceClp: bikeComponents.priceClp,
      replacedAt: bikeComponents.replacedAt,
      replacedByComponentId: bikeComponents.replacedByComponentId,
      workOrderId: bikeComponents.workOrderId,
    })
    .from(bikeComponents)
    .where(
      and(
        eq(bikeComponents.branchId, actor.branchId),
        eq(bikeComponents.bikeId, bikeId),
        isNull(bikeComponents.voidedAt),
      ),
    )
    .orderBy(desc(bikeComponents.installedAt), desc(bikeComponents.createdAt));
}
