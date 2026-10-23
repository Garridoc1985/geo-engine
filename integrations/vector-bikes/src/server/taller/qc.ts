import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getEmailEnv } from "../../lib/env.ts";
import { log } from "../../lib/log.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { qcChecks, workOrders } from "../db/schema-orders.ts";
import { auditLog, bikes, customers } from "../db/schema-taller.ts";
import type { NotifyDeps } from "../email/notifications.ts";
import { readyForPickupEmail } from "../email/templates.ts";
import { createTransport } from "../email/transport.ts";
import { recordAudit } from "./audit.ts";
import { formatOrderNumber, recordStatusChange } from "./orders.ts";
import { QC_CHECK_KEYS, QC_REQUIRE_SECOND_PERSON, QC_RESULTS } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export const qcFormSchema = z.object({
  checks: z.record(
    z.enum(QC_CHECK_KEYS),
    z.object({
      result: z.enum(QC_RESULTS, { error: "Selecciona OK o Falla." }),
      note: z.string().trim().max(300, "La nota no puede superar los 300 caracteres.").default(""),
    }),
  ),
});

function orderFilter(actor: SessionUser, orderId: string) {
  return and(
    eq(workOrders.branchId, actor.branchId),
    eq(workOrders.id, orderId),
    isNull(workOrders.voidedAt),
  );
}

async function recordQcOutcome(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  selfCheck: boolean,
  failedItems: (typeof QC_CHECK_KEYS)[number][],
  now: Date,
) {
  const approved = failedItems.length === 0;
  const status = approved ? "lista_para_retirar" : "en_reparacion";
  await db
    .update(workOrders)
    .set({
      status,
      qcApprovedAt: approved ? now : null,
      qcApprovedBy: approved ? actor.id : null,
      qcSelfChecked: approved && selfCheck,
      updatedAt: now,
    })
    .where(orderFilter(actor, orderId));
  const history = await recordStatusChange(
    db,
    {
      branchId: actor.branchId,
      orderId,
      from: "control_calidad",
      to: status,
      actorUserId: actor.id,
      note: approved ? undefined : "Control rechazado",
    },
    now,
  );
  if (!history.ok) throw new Error("No se pudo registrar el estado del control de calidad.");
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: approved ? "qc.approved" : "qc.rejected",
      entity: "work_order",
      entityId: orderId,
      details: approved ? { selfCheck } : { failedItems },
    },
    now,
  );
  return { ok: true, status } as const;
}

async function readyNotificationOrder(db: AppDb, actor: SessionUser, orderId: string) {
  const [order] = await db
    .select({
      number: workOrders.number,
      totalClp: workOrders.totalClp,
      paidClp: workOrders.paidClp,
      customerName: customers.name,
      email: customers.email,
      brand: bikes.brand,
      model: bikes.model,
    })
    .from(workOrders)
    .innerJoin(
      customers,
      and(eq(customers.id, workOrders.customerId), eq(customers.branchId, actor.branchId)),
    )
    .innerJoin(bikes, and(eq(bikes.id, workOrders.bikeId), eq(bikes.branchId, actor.branchId)))
    .where(orderFilter(actor, orderId));
  return order;
}

/** Post-commit: un fallo del aviso nunca cambia el resultado del control. */
async function notifyReadyForPickup(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  now: Date,
  deps: NotifyDeps,
) {
  try {
    const order = await readyNotificationOrder(db, actor, orderId);
    if (!order || order.email === null) return;
    const [sent] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.branchId, actor.branchId),
          eq(auditLog.action, "notify.ready_for_pickup"),
          eq(auditLog.entityId, orderId),
        ),
      )
      .limit(1);
    if (sent) return;
    const email = readyForPickupEmail({
      ...order,
      orderNumber: formatOrderNumber(order.number),
      bike: `${order.brand} ${order.model}`.trim(),
    });
    const transport = deps.transport ?? createTransport(deps.env ?? getEmailEnv());
    await transport.send({ to: order.email, ...email });
    await recordAudit(
      db,
      {
        branchId: actor.branchId,
        actorUserId: actor.id,
        action: "notify.ready_for_pickup",
        entity: "work_order",
        entityId: orderId,
        details: { sent: true },
      },
      now,
    );
  } catch {
    log.error("email.failed", { kind: "ready_for_pickup", orderId });
  }
}

export async function submitQc(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
  deps: NotifyDeps = {},
) {
  if (!can(actor.role, "qc.approve")) return { ok: false, code: "forbidden" } as const;
  const parsed = qcFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(workOrders)
      .where(orderFilter(actor, orderId))
      .for("update");
    if (order?.status !== "control_calidad") return { ok: false, code: "invalid_status" } as const;
    const selfCheck = order.assignedMechanicId === null || order.assignedMechanicId === actor.id;
    if (QC_REQUIRE_SECOND_PERSON && selfCheck)
      return { ok: false, code: "second_person_required" } as const;
    await tx.insert(qcChecks).values(
      QC_CHECK_KEYS.map((itemKey) => ({
        branchId: actor.branchId,
        workOrderId: orderId,
        itemKey,
        result: parsed.data.checks[itemKey].result,
        note: parsed.data.checks[itemKey].note || null,
        actorUserId: actor.id,
        selfCheck,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const failedItems = QC_CHECK_KEYS.filter((key) => parsed.data.checks[key].result === "falla");
    return recordQcOutcome(tx, actor, orderId, selfCheck, failedItems, now);
  });
  if (result.ok && result.status === "lista_para_retirar") {
    await notifyReadyForPickup(db, actor, orderId, now, deps);
  }
  return result;
}

export async function listQcChecks(db: AppDb, actor: SessionUser, orderId: string) {
  if (!can(actor.role, "orders.edit")) return [];
  const [order] = await db.select().from(workOrders).where(orderFilter(actor, orderId));
  if (!order || !canAccessOrder(actor, order)) return [];
  return db
    .select()
    .from(qcChecks)
    .where(and(eq(qcChecks.branchId, actor.branchId), eq(qcChecks.workOrderId, orderId)))
    .orderBy(asc(qcChecks.createdAt), asc(qcChecks.itemKey), asc(qcChecks.id));
}
