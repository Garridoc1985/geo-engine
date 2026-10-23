import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { workOrderApprovals, workOrderItems, workOrders } from "../db/schema-orders.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { recordAudit } from "./audit.ts";
import type { AuditAction } from "./audit.ts";
import { recomputeOrderTotals } from "./items.ts";
import { recordStatusChange } from "./orders.ts";
import type { OrderStatus } from "./rules.ts";
import { hashShareToken, newShareToken, shareTokenSchema } from "./share-tokens.ts";
import { canAccessOrder } from "./status.ts";

export const approvalFormSchema = z.object({
  description: z.string().trim().min(5).max(500),
  recommendation: z.string().trim().min(5).max(500),
  priceClp: z.coerce.number().int().min(1).max(10_000_000),
});
type ApprovalInput = z.infer<typeof approvalFormSchema>;

function orderFilter(actor: SessionUser, orderId: string) {
  return and(
    eq(workOrders.branchId, actor.branchId),
    eq(workOrders.id, orderId),
    isNull(workOrders.voidedAt),
  );
}

async function accessOrder(db: AppDb, actor: SessionUser, orderId: string, lock = false) {
  const query = db.select().from(workOrders).where(orderFilter(actor, orderId));
  const [order] = await (lock ? query.for("update") : query);
  if (!order) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  return { ok: true, order } as const;
}

function allowsProposal(status: string) {
  return ["diagnostico", "en_reparacion", "esperando_repuesto", "esperando_aprobacion"].includes(
    status,
  );
}

async function waitForApproval(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  from: OrderStatus,
  now: Date,
) {
  if (from === "esperando_aprobacion") return;
  await db
    .update(workOrders)
    .set({ status: "esperando_aprobacion", updatedAt: now })
    .where(orderFilter(actor, orderId));
  const recorded = await recordStatusChange(
    db,
    {
      branchId: actor.branchId,
      orderId,
      from,
      to: "esperando_aprobacion",
      actorUserId: actor.id,
      note: "Propuesta de adicional",
    },
    now,
  );
  if (!recorded.ok) throw new Error("Transición de propuesta no válida.");
}

async function auditApproval(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
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
      entityId: orderId,
      details,
    },
    now,
  );
}

export async function createApproval(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: ApprovalInput,
  now: Date,
) {
  if (!can(actor.role, "approvals.create")) return { ok: false, code: "forbidden" } as const;
  const parsed = approvalFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const access = await accessOrder(db, actor, orderId);
  if (!access.ok) return access;
  if (!allowsProposal(access.order.status)) return { ok: false, code: "invalid_status" } as const;
  return db.transaction(async (tx) => {
    const locked = await accessOrder(tx, actor, orderId, true);
    if (!locked.ok) return locked;
    if (!allowsProposal(locked.order.status)) return { ok: false, code: "invalid_status" } as const;
    const token = newShareToken();
    const [approval] = await tx
      .insert(workOrderApprovals)
      .values({
        ...parsed.data,
        branchId: actor.branchId,
        workOrderId: orderId,
        tokenHash: hashShareToken(token),
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workOrderApprovals.id });
    if (!approval) throw new Error("No se pudo crear la propuesta de adicional.");
    await waitForApproval(tx, actor, orderId, locked.order.status as OrderStatus, now);
    await auditApproval(
      tx,
      actor,
      orderId,
      "approval.created",
      { approvalId: approval.id, priceClp: parsed.data.priceClp },
      now,
    );
    return { ok: true, approvalId: approval.id, token } as const;
  });
}

export function approvalLink(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/aprobacion/${token}`;
}

export function whatsappShareLink(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

function pendingApproval(actor: SessionUser, approvalId: string) {
  return and(
    eq(workOrderApprovals.branchId, actor.branchId),
    eq(workOrderApprovals.id, approvalId),
    isNull(workOrderApprovals.decidedAt),
    isNull(workOrderApprovals.voidedAt),
  );
}

export async function regenerateApprovalLink(
  db: AppDb,
  actor: SessionUser,
  approvalId: string,
  now: Date,
) {
  if (!can(actor.role, "approvals.create")) return { ok: false, code: "forbidden" } as const;
  return db.transaction(async (tx) => {
    const [approval] = await tx
      .select({ workOrderId: workOrderApprovals.workOrderId })
      .from(workOrderApprovals)
      .where(pendingApproval(actor, approvalId));
    if (!approval) return { ok: false, code: "not_found" } as const;
    const access = await accessOrder(tx, actor, approval.workOrderId);
    if (!access.ok) return access;
    const token = newShareToken();
    const [updated] = await tx
      .update(workOrderApprovals)
      .set({ tokenHash: hashShareToken(token), updatedAt: now })
      .where(pendingApproval(actor, approvalId))
      .returning({ id: workOrderApprovals.id });
    if (!updated) return { ok: false, code: "not_found" } as const;
    await auditApproval(
      tx,
      actor,
      approval.workOrderId,
      "approval.link_regenerated",
      { approvalId },
      now,
    );
    return { ok: true, token } as const;
  });
}

export async function listApprovals(db: AppDb, actor: SessionUser, orderId: string) {
  const access = await accessOrder(db, actor, orderId);
  if (!access.ok) return [];
  return db
    .select({
      id: workOrderApprovals.id,
      description: workOrderApprovals.description,
      recommendation: workOrderApprovals.recommendation,
      priceClp: workOrderApprovals.priceClp,
      decision: workOrderApprovals.decision,
      decidedAt: workOrderApprovals.decidedAt,
      createdAt: workOrderApprovals.createdAt,
    })
    .from(workOrderApprovals)
    .where(
      and(
        eq(workOrderApprovals.branchId, actor.branchId),
        eq(workOrderApprovals.workOrderId, orderId),
        isNull(workOrderApprovals.voidedAt),
      ),
    )
    .orderBy(desc(workOrderApprovals.createdAt), desc(workOrderApprovals.id));
}

export async function viewApproval(db: AppDb, token: string) {
  if (!shareTokenSchema.safeParse(token).success) return { view: "invalid" } as const;
  const [row] = await db
    .select({
      name: customers.name,
      brand: bikes.brand,
      model: bikes.model,
      description: workOrderApprovals.description,
      recommendation: workOrderApprovals.recommendation,
      priceClp: workOrderApprovals.priceClp,
    })
    .from(workOrderApprovals)
    .innerJoin(workOrders, eq(workOrders.id, workOrderApprovals.workOrderId))
    .innerJoin(customers, eq(customers.id, workOrders.customerId))
    .innerJoin(bikes, eq(bikes.id, workOrders.bikeId))
    .where(
      and(
        eq(workOrderApprovals.tokenHash, hashShareToken(token)),
        isNull(workOrderApprovals.decidedAt),
        isNull(workOrderApprovals.voidedAt),
        isNull(workOrders.voidedAt),
        eq(workOrders.status, "esperando_aprobacion"),
      ),
    );
  if (!row) return { view: "invalid" } as const;
  return {
    view: "pending",
    approval: {
      firstName: row.name.trim().split(/\s+/)[0] ?? "",
      bike: `${row.brand} ${row.model}`.trim(),
      description: row.description,
      recommendation: row.recommendation,
      priceClp: row.priceClp,
    },
  } as const;
}

type Approval = typeof workOrderApprovals.$inferSelect;

async function addApprovedItem(db: AppDb, approval: Approval, now: Date) {
  await db.insert(workOrderItems).values({
    branchId: approval.branchId,
    workOrderId: approval.workOrderId,
    kind: "servicio",
    origin: "adicional",
    description: approval.description,
    quantity: 1,
    unitPriceClp: approval.priceClp,
    approvalId: approval.id,
    createdBy: approval.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await recomputeOrderTotals(db, approval.workOrderId, now);
}

async function resumeAfterApproval(db: AppDb, approval: Approval, now: Date) {
  const [pending] = await db
    .select({ id: workOrderApprovals.id })
    .from(workOrderApprovals)
    .where(
      and(
        eq(workOrderApprovals.branchId, approval.branchId),
        eq(workOrderApprovals.workOrderId, approval.workOrderId),
        isNull(workOrderApprovals.decidedAt),
        isNull(workOrderApprovals.voidedAt),
      ),
    )
    .limit(1);
  if (pending) return;
  const [resumed] = await db
    .update(workOrders)
    .set({ status: "en_reparacion", updatedAt: now })
    .where(
      and(
        eq(workOrders.branchId, approval.branchId),
        eq(workOrders.id, approval.workOrderId),
        isNull(workOrders.voidedAt),
        eq(workOrders.status, "esperando_aprobacion"),
      ),
    )
    .returning({ id: workOrders.id });
  if (!resumed) return;
  const recorded = await recordStatusChange(
    db,
    {
      branchId: approval.branchId,
      orderId: approval.workOrderId,
      from: "esperando_aprobacion",
      to: "en_reparacion",
      actorUserId: null,
      note: "Respuesta del cliente",
    },
    now,
  );
  if (!recorded.ok) throw new Error("Transición de respuesta no válida.");
}

async function applyApprovalDecision(db: AppDb, approval: Approval, now: Date) {
  // Serializa totales y la última respuesta entre propuestas de una misma orden.
  await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, approval.branchId), eq(workOrders.id, approval.workOrderId)))
    .for("update");
  if (approval.decision === "aprobado") await addApprovedItem(db, approval, now);
  await resumeAfterApproval(db, approval, now);
  await recordAudit(
    db,
    {
      branchId: approval.branchId,
      actorUserId: null,
      action: "approval.decided",
      entity: "work_order",
      entityId: approval.workOrderId,
      details: { decision: approval.decision },
    },
    now,
  );
}

export async function decideApproval(
  db: AppDb,
  token: string,
  decision: "aprobado" | "rechazado",
  ipHash: string | null,
  now: Date,
) {
  if (!shareTokenSchema.safeParse(token).success) return { ok: false, code: "invalid" } as const;
  const hash = hashShareToken(token);
  return db.transaction(async (tx) => {
    const [approval] = await tx
      .update(workOrderApprovals)
      .set({ decidedAt: now, decision, decidedIpHash: ipHash, updatedAt: now })
      .where(
        and(
          eq(workOrderApprovals.tokenHash, hash),
          isNull(workOrderApprovals.decidedAt),
          isNull(workOrderApprovals.voidedAt),
          sql`exists (select 1 from ${workOrders} o
          where o.id = ${workOrderApprovals.workOrderId}
            and o.voided_at is null and o.status = ${"esperando_aprobacion"})`,
        ),
      )
      .returning();
    if (!approval) {
      const [existing] = await tx
        .select({ id: workOrderApprovals.id })
        .from(workOrderApprovals)
        .where(eq(workOrderApprovals.tokenHash, hash))
        .limit(1);
      return { ok: false, code: existing ? "already_decided" : "invalid" } as const;
    }
    await applyApprovalDecision(tx, approval, now);
    return { ok: true } as const;
  });
}
