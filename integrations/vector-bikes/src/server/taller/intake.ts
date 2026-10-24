import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { intakeAccessories, intakeChecks, workOrders } from "../db/schema-orders.ts";
import { getOrderHeader } from "./orders.ts";
import { INTAKE_CHECK_KEYS, INTAKE_RESULTS } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export const checklistFormSchema = z.object({
  checks: z.partialRecord(
    z.enum(INTAKE_CHECK_KEYS),
    z.object({
      result: z.enum(INTAKE_RESULTS, { error: "Selecciona OK, Revisar o Malo." }),
      note: z.string().trim().max(300, "La nota no puede superar los 300 caracteres.").default(""),
    }),
  ),
  observaciones: z
    .string()
    .trim()
    .max(2000, "Las observaciones no pueden superar los 2000 caracteres.")
    .default(""),
  servicio_solicitado: z
    .string()
    .trim()
    .min(3, "Describe el servicio solicitado con al menos 3 caracteres.")
    .max(500, "El servicio solicitado no puede superar los 500 caracteres."),
});

export const accessoryFormSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Ingresa el accesorio.")
    .max(200, "El accesorio no puede superar los 200 caracteres."),
});

async function accessibleOrder(db: AppDb, actor: SessionUser, orderId: string) {
  const header = await getOrderHeader(db, actor, orderId);
  if (!header) return { ok: false, code: "not_found" } as const;
  const { order } = header;
  if (!canAccessOrder(actor, order)) {
    return { ok: false, code: "forbidden" } as const;
  }
  return { ok: true, order } as const;
}

async function lockOrder(db: AppDb, actor: SessionUser, orderId: string) {
  await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)))
    .for("update");
  return accessibleOrder(db, actor, orderId);
}

type CheckKey = (typeof INTAKE_CHECK_KEYS)[number];
type CheckInput = NonNullable<z.infer<typeof checklistFormSchema>["checks"][CheckKey]>;

async function upsertCheck(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  itemKey: CheckKey,
  check: CheckInput,
  now: Date,
) {
  await db
    .insert(intakeChecks)
    .values({
      branchId: actor.branchId,
      workOrderId: orderId,
      itemKey,
      result: check.result,
      note: check.note || null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [intakeChecks.workOrderId, intakeChecks.itemKey],
      set: { result: check.result, note: check.note || null, updatedAt: now },
      setWhere: eq(intakeChecks.branchId, actor.branchId),
    });
}

export async function saveChecklist(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" } as const;
  const parsed = checklistFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, orderId);
    if (!access.ok) return access;
    if (!["reservada", "recibida"].includes(access.order.status))
      return { ok: false, code: "invalid_state" } as const;
    for (const itemKey of INTAKE_CHECK_KEYS) {
      const check = parsed.data.checks[itemKey];
      if (check) await upsertCheck(tx, actor, orderId, itemKey, check, now);
    }
    await tx
      .update(workOrders)
      .set({
        observations: parsed.data.observaciones || null,
        requestedService: parsed.data.servicio_solicitado,
        updatedAt: now,
      })
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)));
    return { ok: true } as const;
  });
}

export async function listIntakeChecks(db: AppDb, actor: SessionUser, orderId: string) {
  if (!(await accessibleOrder(db, actor, orderId)).ok) return [];
  return db
    .select()
    .from(intakeChecks)
    .where(and(eq(intakeChecks.branchId, actor.branchId), eq(intakeChecks.workOrderId, orderId)))
    .orderBy(asc(intakeChecks.itemKey));
}

export async function isChecklistComplete(db: AppDb, orderId: string): Promise<boolean> {
  const [order] = await db
    .select({ branchId: workOrders.branchId })
    .from(workOrders)
    .where(eq(workOrders.id, orderId))
    .limit(1);
  if (!order) return false;
  const rows = await db
    .select({ itemKey: intakeChecks.itemKey })
    .from(intakeChecks)
    .where(and(eq(intakeChecks.branchId, order.branchId), eq(intakeChecks.workOrderId, orderId)));
  return INTAKE_CHECK_KEYS.every((key) => rows.some((row) => row.itemKey === key));
}

export async function addAccessory(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" } as const;
  const parsed = accessoryFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, orderId);
    if (!access.ok) return access;
    const [accessory] = await tx
      .insert(intakeAccessories)
      .values({
        branchId: actor.branchId,
        workOrderId: orderId,
        description: parsed.data.description,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!accessory) throw new Error("No se pudo guardar el accesorio.");
    return { ok: true, accessory } as const;
  });
}

export async function voidAccessory(db: AppDb, actor: SessionUser, accessoryId: string, now: Date) {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" } as const;
  return db.transaction(async (tx) => {
    const [accessory] = await tx
      .select()
      .from(intakeAccessories)
      .where(
        and(eq(intakeAccessories.branchId, actor.branchId), eq(intakeAccessories.id, accessoryId)),
      )
      .limit(1);
    if (!accessory) return { ok: false, code: "not_found" } as const;
    const access = await lockOrder(tx, actor, accessory.workOrderId);
    if (!access.ok) return access;
    await tx
      .update(intakeAccessories)
      .set({ voidedAt: now, voidedBy: actor.id, updatedAt: now })
      .where(
        and(
          eq(intakeAccessories.branchId, actor.branchId),
          eq(intakeAccessories.id, accessoryId),
          isNull(intakeAccessories.voidedAt),
        ),
      );
    return { ok: true } as const;
  });
}

export async function listAccessories(db: AppDb, actor: SessionUser, orderId: string) {
  if (!(await accessibleOrder(db, actor, orderId)).ok) return [];
  return db
    .select()
    .from(intakeAccessories)
    .where(
      and(
        eq(intakeAccessories.branchId, actor.branchId),
        eq(intakeAccessories.workOrderId, orderId),
        isNull(intakeAccessories.voidedAt),
      ),
    )
    .orderBy(asc(intakeAccessories.createdAt), asc(intakeAccessories.id));
}
