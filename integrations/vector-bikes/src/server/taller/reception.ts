import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getEmailEnv } from "../../lib/env.ts";
import { log } from "../../lib/log.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { orderPhotos, orderSignatures, workOrders } from "../db/schema-orders.ts";
import { auditLog, bikes, customers } from "../db/schema-taller.ts";
import type { NotifyDeps } from "../email/notifications.ts";
import { receivedBikeEmail } from "../email/templates.ts";
import { createTransport } from "../email/transport.ts";
import { isStorageKey } from "../storage/storage.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import { recordAudit } from "./audit.ts";
import { isChecklistComplete, listAccessories } from "./intake.ts";
import { listItems } from "./items.ts";
import { formatOrderNumber, getOrderHeader, recordStatusChange } from "./orders.ts";
import { canAccessOrder } from "./status.ts";

export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const signaturePrefix = "data:image/png;base64,";
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const signatureKindSchema = z.enum(["recepcion", "entrega"]);
type SignatureKind = z.infer<typeof signatureKindSchema>;
type MissingItem = "checklist" | "fotos" | "fecha" | "firma";
const receptionInputSchema = z.object({
  orderId: z.uuid(),
  signatureDataUrl: z.string(),
  signedByName: z.string(),
});
const signerNameSchema = z.string().trim().min(2).max(80);
const signatureRowSchema = z.object({
  orderId: z.uuid(),
  kind: signatureKindSchema,
  storageKey: z.string().refine(isStorageKey),
  signedByName: signerNameSchema,
});
type ReceptionInput = z.infer<typeof receptionInputSchema>;
type ReceptionCode = "forbidden" | "not_found" | "invalid_status" | "already_signed";

export function decodeSignature(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith(signaturePrefix)) return null;
  const payload = dataUrl.slice(signaturePrefix.length);
  if (payload.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4) return null;
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES || !bytes.subarray(0, 8).equals(pngMagic)) return null;
  if (bytes.toString("base64") !== payload) return null;
  return bytes;
}

export async function uploadSignature(
  storage: ObjectStorage,
  orderId: string,
  kind: SignatureKind,
  bytes: Buffer,
): Promise<string> {
  const ids = z.object({ orderId: z.uuid(), kind: signatureKindSchema }).parse({ orderId, kind });
  const key = `orders/${ids.orderId}/signature-${ids.kind}-${randomUUID()}.png`;
  try {
    await storage.put(key, bytes, "image/png");
  } catch (error) {
    await storage.delete(key);
    throw error;
  }
  return key;
}

/** Recibe la transacción del flujo que guarda la firma. */
export async function insertSignatureRow(
  db: AppDb,
  actor: SessionUser,
  input: z.infer<typeof signatureRowSchema>,
  now: Date,
) {
  const parsed = signatureRowSchema.parse(input);
  const [signature] = await db
    .insert(orderSignatures)
    .values({
      branchId: actor.branchId,
      workOrderId: parsed.orderId,
      kind: parsed.kind,
      storageKey: parsed.storageKey,
      signedByName: parsed.signedByName,
      signedAt: now,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!signature) throw new Error("No se pudo guardar la firma.");
  return signature;
}

async function hasReceptionSignature(db: AppDb, branchId: string, orderId: string) {
  const [signature] = await db
    .select({ id: orderSignatures.id })
    .from(orderSignatures)
    .where(
      and(
        eq(orderSignatures.branchId, branchId),
        eq(orderSignatures.workOrderId, orderId),
        eq(orderSignatures.kind, "recepcion"),
      ),
    )
    .limit(1);
  return Boolean(signature);
}

export async function receptionSignature(db: AppDb, actor: SessionUser, orderId: string) {
  const [signature] = await db
    .select({ signedByName: orderSignatures.signedByName, signedAt: orderSignatures.signedAt })
    .from(orderSignatures)
    .where(
      and(
        eq(orderSignatures.branchId, actor.branchId),
        eq(orderSignatures.workOrderId, orderId),
        eq(orderSignatures.kind, "recepcion"),
      ),
    )
    .limit(1);
  return signature ?? null;
}

export async function receptionReadiness(db: AppDb, orderId: string): Promise<MissingItem[]> {
  const [order] = await db.select().from(workOrders).where(eq(workOrders.id, orderId)).limit(1);
  if (!order) return ["checklist", "fotos", "fecha", "firma"];
  const [photo] = await db
    .select({ id: orderPhotos.id })
    .from(orderPhotos)
    .where(
      and(
        eq(orderPhotos.branchId, order.branchId),
        eq(orderPhotos.workOrderId, orderId),
        eq(orderPhotos.stage, "recepcion"),
        isNull(orderPhotos.voidedAt),
      ),
    )
    .limit(1);
  const missing: MissingItem[] = [];
  if (!(await isChecklistComplete(db, orderId))) missing.push("checklist");
  if (!photo) missing.push("fotos");
  if (order.deliveryDateConfirmedAt === null) missing.push("fecha");
  if (!(await hasReceptionSignature(db, order.branchId, orderId))) missing.push("firma");
  return missing;
}

async function receptionAccess(db: AppDb, actor: SessionUser, orderId: string) {
  const header = await getOrderHeader(db, actor, orderId);
  if (!header || header.order.voidedAt) return { ok: false, code: "not_found" } as const;
  const { order } = header;
  if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
  if (order.status !== "reservada") return { ok: false, code: "invalid_status" } as const;
  return { ok: true } as const;
}

class ReceptionWriteError extends Error {
  code: ReceptionCode;
  constructor(code: ReceptionCode) {
    super("No se pudo finalizar la recepción.");
    this.code = code;
  }
}

async function recordReceptionChange(db: AppDb, actor: SessionUser, orderId: string, now: Date) {
  await recordStatusChange(
    db,
    {
      branchId: actor.branchId,
      orderId,
      from: "reservada",
      to: "recibida",
      actorUserId: actor.id,
    },
    now,
  );
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: "order.status_changed",
      entity: "work_order",
      entityId: orderId,
      details: { from: "reservada", to: "recibida" },
    },
    now,
  );
}

async function commitReception(
  db: AppDb,
  actor: SessionUser,
  input: ReceptionInput,
  storageKey: string,
  now: Date,
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, input.orderId)))
      .for("update");
    const access = await receptionAccess(tx, actor, input.orderId);
    if (!access.ok) throw new ReceptionWriteError(access.code);
    if (await hasReceptionSignature(tx, actor.branchId, input.orderId))
      throw new ReceptionWriteError("already_signed");
    await insertSignatureRow(
      tx,
      actor,
      {
        orderId: input.orderId,
        kind: "recepcion",
        storageKey,
        signedByName: input.signedByName,
      },
      now,
    );
    await tx
      .update(workOrders)
      .set({ status: "recibida", receivedAt: now, updatedAt: now })
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, input.orderId)));
    await recordReceptionChange(tx, actor, input.orderId, now);
    return { ok: true } as const;
  });
}

async function receivedNotificationOrder(db: AppDb, actor: SessionUser, orderId: string) {
  const [order] = await db
    .select({
      number: workOrders.number,
      requestedService: workOrders.requestedService,
      estimatedDeliveryDate: workOrders.estimatedDeliveryDate,
      warrantyOfOrderId: workOrders.warrantyOfOrderId,
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
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        eq(workOrders.id, orderId),
        isNull(workOrders.voidedAt),
      ),
    );
  return order;
}

async function warrantyOrderNumber(db: AppDb, actor: SessionUser, orderId: string | null) {
  if (orderId === null) return null;
  const [original] = await db
    .select({ number: workOrders.number })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)));
  return original ? formatOrderNumber(original.number) : null;
}

async function hasReceivedNotification(db: AppDb, actor: SessionUser, orderId: string) {
  const [sent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.branchId, actor.branchId),
        eq(auditLog.action, "notify.received"),
        eq(auditLog.entityId, orderId),
      ),
    )
    .limit(1);
  return Boolean(sent);
}

/** Post-commit: un fallo del aviso nunca cambia el resultado de la recepción. */
async function notifyReceived(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  now: Date,
  deps: NotifyDeps,
) {
  try {
    const order = await receivedNotificationOrder(db, actor, orderId);
    if (!order || order.email === null) return;
    if (await hasReceivedNotification(db, actor, orderId)) return;
    const email = receivedBikeEmail({
      ...order,
      orderNumber: formatOrderNumber(order.number),
      bike: `${order.brand} ${order.model}`.trim(),
      items: await listItems(db, actor, orderId),
      accessories: (await listAccessories(db, actor, orderId)).map((item) => item.description),
      warrantyOfNumber: await warrantyOrderNumber(db, actor, order.warrantyOfOrderId),
    });
    const transport = deps.transport ?? createTransport(deps.env ?? getEmailEnv());
    await transport.send({ to: order.email, ...email });
    await recordAudit(
      db,
      {
        branchId: actor.branchId,
        actorUserId: actor.id,
        action: "notify.received",
        entity: "work_order",
        entityId: orderId,
        details: { sent: true },
      },
      now,
    );
  } catch {
    log.error("email.failed", { kind: "received", orderId });
  }
}

export async function finalizeReception(
  db: AppDb,
  storage: ObjectStorage,
  actor: SessionUser,
  input: ReceptionInput,
  now: Date,
  deps: NotifyDeps = {},
) {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" } as const;
  const parsed = receptionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const access = await receptionAccess(db, actor, parsed.data.orderId);
  if (!access.ok) return access;
  const missing: MissingItem[] = (await receptionReadiness(db, parsed.data.orderId)).filter(
    (item) => item !== "firma",
  );
  if (parsed.data.signatureDataUrl === "") missing.push("firma");
  if (missing.length) return { ok: false, code: "incomplete", missing } as const;
  const bytes = decodeSignature(parsed.data.signatureDataUrl);
  if (!bytes) return { ok: false, code: "invalid_signature" } as const;
  if (await hasReceptionSignature(db, actor.branchId, parsed.data.orderId))
    return { ok: false, code: "already_signed" } as const;
  const name = signerNameSchema.safeParse(parsed.data.signedByName);
  if (!name.success) return { ok: false, code: "validation_error" } as const;
  const key = await uploadSignature(storage, parsed.data.orderId, "recepcion", bytes);
  // El `catch` compensa la escritura: solo cubre el commit. El aviso va fuera,
  // para que un fallo del correo no pueda borrar la firma de una recepción ya
  // confirmada.
  let result: Awaited<ReturnType<typeof commitReception>>;
  try {
    result = await commitReception(
      db,
      actor,
      { ...parsed.data, signedByName: name.data },
      key,
      now,
    );
  } catch (error) {
    await storage.delete(key);
    if (error instanceof ReceptionWriteError) return { ok: false, code: error.code } as const;
    throw error;
  }
  if (result.ok) await notifyReceived(db, actor, parsed.data.orderId, now, deps);
  return result;
}
