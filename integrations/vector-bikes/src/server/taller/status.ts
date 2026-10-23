import { and, asc, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { workOrders, workOrderStatusHistory } from "../db/schema-orders.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { users } from "../db/schema.ts";
import { recordAudit } from "./audit.ts";
import type { AuditAction } from "./audit.ts";
import { getOrderHeader, recordStatusChange } from "./orders.ts";
import {
  isManualTransition,
  MECHANIC_UNASSIGNED_ACCESS_STATUSES,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
} from "./rules.ts";
import type { OrderStatus } from "./rules.ts";

export const orderScopeSchema = z.object({
  scope: z.enum(["open", "all", "mine"]).default("open"),
});
export const statusChangeSchema = z.object({
  to: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(2000).nullable().default(null),
});
export const mechanicAssignmentSchema = z.object({ mechanicId: z.uuid().nullable() });
export const orderNotesSchema = z
  .object({
    diagnosis: z.string().trim().max(2000).nullable().optional(),
    observations: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

type OrderAccess = { assignedMechanicId: string | null; status: string };
export function canAccessOrder(user: SessionUser, order: OrderAccess): boolean {
  return (
    user.role !== "mechanic" ||
    order.assignedMechanicId === user.id ||
    (order.assignedMechanicId === null &&
      (MECHANIC_UNASSIGNED_ACCESS_STATUSES as readonly string[]).includes(order.status))
  );
}

function orderFilter(actor: SessionUser, id: string) {
  return and(
    eq(workOrders.branchId, actor.branchId),
    eq(workOrders.id, id),
    isNull(workOrders.voidedAt),
  );
}

async function lockOrder(db: AppDb, actor: SessionUser, id: string) {
  const [order] = await db.select().from(workOrders).where(orderFilter(actor, id)).for("update");
  if (!order) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  return { ok: true, order } as const;
}

async function auditOrder(
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
      entity: "work_order",
      entityId: id,
      details,
    },
    now,
  );
}

async function orderHistory(db: AppDb, actor: SessionUser, id: string) {
  return db
    .select({ history: workOrderStatusHistory, authorName: users.name })
    .from(workOrderStatusHistory)
    .leftJoin(
      users,
      and(eq(users.id, workOrderStatusHistory.actorUserId), eq(users.branchId, actor.branchId)),
    )
    .where(
      and(
        eq(workOrderStatusHistory.branchId, actor.branchId),
        eq(workOrderStatusHistory.workOrderId, id),
      ),
    )
    .orderBy(asc(workOrderStatusHistory.createdAt), asc(workOrderStatusHistory.id));
}

export async function orderDetail(db: AppDb, actor: SessionUser, id: string) {
  const header = await getOrderHeader(db, actor, id);
  if (!header || header.order.voidedAt) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, header.order)) return { ok: false, code: "forbidden" } as const;
  const { customer, order, bike } = header;
  const [warranty] = order.warrantyOfOrderId
    ? await db
        .select({ number: workOrders.number })
        .from(workOrders)
        .where(
          and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, order.warrantyOfOrderId)),
        )
    : [];
  const [mechanic] = order.assignedMechanicId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(and(eq(users.branchId, actor.branchId), eq(users.id, order.assignedMechanicId)))
    : [];
  return {
    ok: true,
    order,
    bike,
    customer: {
      id: customer.id,
      name: customer.name,
      ...(can(actor.role, "customers.manage")
        ? { phoneE164: customer.phoneE164, email: customer.email, rut: customer.rut }
        : {}),
    },
    history: await orderHistory(db, actor, id),
    warrantyOfNumber: warranty?.number ?? null,
    mechanicName: mechanic?.name ?? null,
  } as const;
}

export async function listOrders(
  db: AppDb,
  actor: SessionUser,
  input: z.infer<typeof orderScopeSchema>,
) {
  const parsed = orderScopeSchema.safeParse(input);
  if (!parsed.success) return [];
  const mechanicAccess = or(
    eq(workOrders.assignedMechanicId, actor.id),
    and(
      isNull(workOrders.assignedMechanicId),
      inArray(workOrders.status, [...MECHANIC_UNASSIGNED_ACCESS_STATUSES]),
    ),
  );
  return db
    .select({
      order: workOrders,
      customerName: customers.name,
      bikeBrand: bikes.brand,
      bikeModel: bikes.model,
    })
    .from(workOrders)
    .innerJoin(
      customers,
      and(eq(customers.id, workOrders.customerId), eq(customers.branchId, actor.branchId)),
    )
    .innerJoin(bikes, and(eq(bikes.id, workOrders.bikeId), eq(bikes.branchId, actor.branchId)))
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        isNull(workOrders.voidedAt),
        parsed.data.scope === "open"
          ? notInArray(workOrders.status, [...TERMINAL_STATUSES])
          : undefined,
        parsed.data.scope === "mine" ? eq(workOrders.assignedMechanicId, actor.id) : undefined,
        actor.role === "mechanic" ? mechanicAccess : undefined,
      ),
    )
    .orderBy(desc(workOrders.number));
}

export async function changeOrderStatus(
  db: AppDb,
  actor: SessionUser,
  id: string,
  to: OrderStatus,
  note: string | null,
  now: Date,
) {
  const permission =
    to === "cancelada" || to === "trabajo_rechazado" ? "orders.cancel" : "orders.edit";
  if (!can(actor.role, permission)) return { ok: false, code: "forbidden" } as const;
  const parsed = statusChangeSchema.safeParse({ to, note });
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, id);
    if (!access.ok) return access;
    const from = access.order.status as OrderStatus;
    if (!isManualTransition(from, parsed.data.to))
      return { ok: false, code: "invalid_transition" } as const;
    const recorded = await recordStatusChange(
      tx,
      {
        branchId: actor.branchId,
        orderId: id,
        from,
        to: parsed.data.to,
        actorUserId: actor.id,
        note: parsed.data.note ?? undefined,
      },
      now,
    );
    if (!recorded.ok) return recorded;
    await tx
      .update(workOrders)
      .set({ status: parsed.data.to, updatedAt: now })
      .where(orderFilter(actor, id));
    await auditOrder(
      tx,
      actor,
      id,
      "order.status_changed",
      { from, to: parsed.data.to, note: parsed.data.note },
      now,
    );
    return { ok: true } as const;
  });
}

export async function listMechanics(db: AppDb, actor: SessionUser) {
  if (!can(actor.role, "orders.assign")) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(eq(users.branchId, actor.branchId), eq(users.role, "mechanic"), eq(users.isActive, true)),
    )
    .orderBy(asc(users.name), asc(users.id));
}

async function writeAssignment(
  db: AppDb,
  actor: SessionUser,
  id: string,
  mechanicId: string | null,
  now: Date,
) {
  await db
    .update(workOrders)
    .set({ assignedMechanicId: mechanicId, updatedAt: now })
    .where(orderFilter(actor, id));
  await auditOrder(db, actor, id, "order.assigned", { mechanicId }, now);
  return { ok: true } as const;
}

export async function assignMechanic(
  db: AppDb,
  actor: SessionUser,
  id: string,
  mechanicId: string | null,
  now: Date,
) {
  if (!can(actor.role, "orders.assign")) return { ok: false, code: "forbidden" } as const;
  const parsed = mechanicAssignmentSchema.safeParse({ mechanicId });
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, id);
    if (!access.ok) return access;
    if (parsed.data.mechanicId !== null) {
      const [mechanic] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.branchId, actor.branchId),
            eq(users.id, parsed.data.mechanicId),
            eq(users.role, "mechanic"),
            eq(users.isActive, true),
          ),
        )
        .for("share");
      if (!mechanic) return { ok: false, code: "not_found" } as const;
    }
    return writeAssignment(tx, actor, id, parsed.data.mechanicId, now);
  });
}

export async function takeOrder(db: AppDb, actor: SessionUser, id: string, now: Date) {
  if (!can(actor.role, "orders.edit") || actor.role !== "mechanic")
    return { ok: false, code: "forbidden" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, id);
    if (!access.ok) return access;
    if (
      access.order.assignedMechanicId !== null ||
      access.order.status === "reservada" ||
      !(MECHANIC_UNASSIGNED_ACCESS_STATUSES as readonly string[]).includes(access.order.status)
    )
      return { ok: false, code: "invalid_status" } as const;
    return writeAssignment(tx, actor, id, actor.id, now);
  });
}

export async function updateOrderNotes(
  db: AppDb,
  actor: SessionUser,
  id: string,
  input: z.infer<typeof orderNotesSchema>,
  now: Date,
) {
  if (!can(actor.role, "orders.edit")) return { ok: false, code: "forbidden" } as const;
  const parsed = orderNotesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const access = await lockOrder(tx, actor, id);
    if (!access.ok) return access;
    const fields = (Object.keys(parsed.data) as (keyof typeof parsed.data)[]).filter(
      (key) => parsed.data[key] !== undefined && parsed.data[key] !== access.order[key],
    );
    if (fields.length === 0) return { ok: true } as const;
    await tx
      .update(workOrders)
      .set({ ...parsed.data, updatedAt: now })
      .where(orderFilter(actor, id));
    await auditOrder(tx, actor, id, "order.updated", { fields }, now);
    return { ok: true } as const;
  });
}
