import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { orderSignatures, workOrders } from "../db/schema-orders.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import { recordAudit } from "./audit.ts";
import { recordStatusChange } from "./orders.ts";
import { decodeSignature, insertSignatureRow, uploadSignature } from "./reception.ts";
import { canAccessOrder } from "./status.ts";

const deliveryInputSchema = z.object({
  orderId: z.uuid(),
  signatureDataUrl: z.string(),
  signedByName: z.string(),
});
const signerNameSchema = z.string().trim().min(2).max(80);
type DeliveryInput = z.infer<typeof deliveryInputSchema>;
type DeliveryCode =
  | "forbidden"
  | "not_found"
  | "invalid_status"
  | "balance_pending"
  | "already_signed";

class DeliveryWriteError extends Error {
  code: DeliveryCode;
  constructor(code: DeliveryCode) {
    super("No se pudo completar la entrega.");
    this.code = code;
  }
}

function orderFilter(actor: SessionUser, orderId: string) {
  return and(
    eq(workOrders.branchId, actor.branchId),
    eq(workOrders.id, orderId),
    isNull(workOrders.voidedAt),
  );
}

function deliveryAccess(actor: SessionUser, order: typeof workOrders.$inferSelect | undefined) {
  if (!order) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  if (order.status !== "lista_para_retirar") return { ok: false, code: "invalid_status" } as const;
  if (order.paidClp !== order.totalClp) return { ok: false, code: "balance_pending" } as const;
  return { ok: true } as const;
}

async function hasDeliverySignature(db: AppDb, actor: SessionUser, orderId: string) {
  const [signature] = await db
    .select({ id: orderSignatures.id })
    .from(orderSignatures)
    .where(
      and(
        eq(orderSignatures.branchId, actor.branchId),
        eq(orderSignatures.workOrderId, orderId),
        eq(orderSignatures.kind, "entrega"),
      ),
    )
    .limit(1);
  return Boolean(signature);
}

async function recordDeliveryChange(db: AppDb, actor: SessionUser, orderId: string, now: Date) {
  const history = await recordStatusChange(
    db,
    {
      branchId: actor.branchId,
      orderId,
      from: "lista_para_retirar",
      to: "entregada",
      actorUserId: actor.id,
    },
    now,
  );
  if (!history.ok) throw new Error("No se pudo registrar el estado de la entrega.");
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: "order.delivered",
      entity: "work_order",
      entityId: orderId,
      details: { from: "lista_para_retirar", to: "entregada" },
    },
    now,
  );
}

async function commitDelivery(
  db: AppDb,
  actor: SessionUser,
  input: DeliveryInput,
  storageKey: string,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(workOrders)
      .where(orderFilter(actor, input.orderId))
      .for("update");
    const access = deliveryAccess(actor, order);
    if (!access.ok) throw new DeliveryWriteError(access.code);
    if (await hasDeliverySignature(tx, actor, input.orderId))
      throw new DeliveryWriteError("already_signed");
    await insertSignatureRow(
      tx,
      actor,
      {
        orderId: input.orderId,
        kind: "entrega",
        storageKey,
        signedByName: input.signedByName,
      },
      now,
    );
    await tx
      .update(workOrders)
      .set({ status: "entregada", deliveredAt: now, updatedAt: now })
      .where(orderFilter(actor, input.orderId));
    await recordDeliveryChange(tx, actor, input.orderId, now);
    return { ok: true } as const;
  });
}

export async function completeDelivery(
  db: AppDb,
  storage: ObjectStorage,
  actor: SessionUser,
  input: DeliveryInput,
  now: Date,
) {
  if (!can(actor.role, "delivery.complete")) return { ok: false, code: "forbidden" } as const;
  const parsed = deliveryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const [order] = await db
    .select()
    .from(workOrders)
    .where(orderFilter(actor, parsed.data.orderId))
    .limit(1);
  const access = deliveryAccess(actor, order);
  if (!access.ok) return access;
  if (parsed.data.signatureDataUrl === "") return { ok: false, code: "missing_signature" } as const;
  const bytes = decodeSignature(parsed.data.signatureDataUrl);
  if (!bytes) return { ok: false, code: "invalid_signature" } as const;
  if (await hasDeliverySignature(db, actor, parsed.data.orderId))
    return { ok: false, code: "already_signed" } as const;
  const name = signerNameSchema.safeParse(parsed.data.signedByName);
  if (!name.success) return { ok: false, code: "validation_error" } as const;
  const key = await uploadSignature(storage, parsed.data.orderId, "entrega", bytes);
  try {
    return await commitDelivery(db, actor, { ...parsed.data, signedByName: name.data }, key, now);
  } catch (error) {
    await storage.delete(key);
    if (error instanceof DeliveryWriteError) return { ok: false, code: error.code } as const;
    throw error;
  }
}
