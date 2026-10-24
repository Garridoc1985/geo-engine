import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { errorMessage, log } from "../../lib/log.ts";
import { isAllowedOrigin, jsonResponse } from "../api/handlers.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { orderPhotos, orderSignatures, workOrders } from "../db/schema-orders.ts";
import type { WorkOrder } from "../db/schema-orders.ts";
import { InvalidImageError, processPhoto } from "../storage/images.ts";
import { isStorageKey } from "../storage/storage.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import { getOrderHeader } from "./orders.ts";
import { PHOTO_STAGES } from "./rules.ts";
import type { OrderStatus } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export type PhotoStage = (typeof PHOTO_STAGES)[number];
const stageStatuses: Record<PhotoStage, readonly OrderStatus[]> = {
  recepcion: ["reservada", "recibida"],
  reparacion: [
    "diagnostico",
    "esperando_aprobacion",
    "esperando_repuesto",
    "en_reparacion",
    "control_calidad",
  ],
  terminado: ["control_calidad", "lista_para_retirar"],
};

export function stageAcceptsStatus(stage: PhotoStage, status: string): boolean {
  return (stageStatuses[stage] as readonly string[]).includes(status);
}
const photoInputSchema = z.object({
  orderId: z.uuid(),
  stage: z.enum(PHOTO_STAGES),
  bytes: z.instanceof(Buffer),
});
const uploadFormSchema = z.object({
  orderId: z.uuid(),
  etapa: z.enum(PHOTO_STAGES),
  foto: z.instanceof(File),
});
type PhotoInput = z.infer<typeof photoInputSchema>;
type PhotoCode =
  | "forbidden"
  | "not_found"
  | "invalid_status"
  | "invalid_image"
  | "validation_error"
  | "too_large";
const photoStatuses: Record<PhotoCode, number> = {
  forbidden: 403,
  not_found: 404,
  invalid_status: 409,
  invalid_image: 415,
  validation_error: 422,
  too_large: 413,
};

function photoError(status: number, code: string): Response {
  const messages: Record<string, string> = {
    unauthorized: "Inicia sesión para ver o subir fotos.",
    forbidden: "No tienes permiso para realizar esta acción.",
    not_found: "No se encontró la foto o la orden.",
    invalid_status: "No puedes subir fotos de esa etapa en el estado actual.",
    invalid_image: "Ese archivo no es una foto válida.",
    validation_error: "Selecciona una foto, una etapa y una orden válidas.",
    too_large: "La foto pesa más de 15 MB.",
    internal_error: "No se pudo subir la foto. Intenta de nuevo.",
  };
  return jsonResponse(status, { error: messages[code], code });
}

export function photoKeys(orderId: string, photoId: string) {
  const ids = z.object({ orderId: z.uuid(), photoId: z.uuid() }).parse({ orderId, photoId });
  return {
    fullKey: `orders/${ids.orderId}/${ids.photoId}-full.jpg`,
    thumbKey: `orders/${ids.orderId}/${ids.photoId}-thumb.jpg`,
  };
}

function canAccessPhotoOrder(actor: SessionUser, order: WorkOrder, stage?: PhotoStage): boolean {
  return (
    canAccessOrder(actor, order) &&
    (actor.role !== "mechanic" ||
      order.assignedMechanicId !== null ||
      stage === undefined ||
      (stage === "recepcion" && stageAcceptsStatus(stage, order.status)))
  );
}

async function uploadAccess(db: AppDb, actor: SessionUser, input: PhotoInput) {
  const header = await getOrderHeader(db, actor, input.orderId);
  if (!header || header.order.voidedAt) return { ok: false, code: "not_found" } as const;
  if (!canAccessPhotoOrder(actor, header.order, input.stage))
    return { ok: false, code: "forbidden" } as const;
  if (!stageAcceptsStatus(input.stage, header.order.status))
    return { ok: false, code: "invalid_status" } as const;
  return { ok: true } as const;
}

class PhotoWriteError extends Error {
  code: PhotoCode;
  constructor(code: PhotoCode) {
    super("No se pudo guardar la foto.");
    this.code = code;
  }
}

async function insertPhotoRow(
  db: AppDb,
  actor: SessionUser,
  input: PhotoInput,
  row: typeof orderPhotos.$inferInsert,
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, input.orderId)))
      .for("update");
    const access = await uploadAccess(tx, actor, input);
    if (!access.ok) throw new PhotoWriteError(access.code);
    await tx.insert(orderPhotos).values(row);
  });
}

function photoRow(
  actor: SessionUser,
  input: PhotoInput,
  id: string,
  image: Awaited<ReturnType<typeof processPhoto>>,
  now: Date,
): typeof orderPhotos.$inferInsert {
  return {
    id,
    branchId: actor.branchId,
    workOrderId: input.orderId,
    stage: input.stage,
    retentionClass: input.stage === "recepcion" ? "recepcion_6m" : "permanente",
    ...photoKeys(input.orderId, id),
    width: image.width,
    height: image.height,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };
}

export async function uploadOrderPhoto(
  db: AppDb,
  storage: ObjectStorage,
  actor: SessionUser,
  input: PhotoInput,
  now: Date,
) {
  if (!can(actor.role, input.stage === "recepcion" ? "reception.perform" : "photos.upload"))
    return { ok: false, code: "forbidden" } as const;
  const parsed = photoInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  if (input.bytes.length > MAX_PHOTO_BYTES) return { ok: false, code: "too_large" } as const;
  const access = await uploadAccess(db, actor, parsed.data);
  if (!access.ok) return access;
  let image: Awaited<ReturnType<typeof processPhoto>>;
  try {
    image = await processPhoto(input.bytes);
  } catch (error) {
    if (error instanceof InvalidImageError) return { ok: false, code: "invalid_image" } as const;
    throw error;
  }
  const id = randomUUID();
  const keys = photoKeys(input.orderId, id);
  try {
    await storage.put(keys.fullKey, image.full, "image/jpeg");
    await storage.put(keys.thumbKey, image.thumb, "image/jpeg");
    await insertPhotoRow(db, actor, input, photoRow(actor, input, id, image, now));
  } catch (error) {
    await Promise.allSettled([storage.delete(keys.fullKey), storage.delete(keys.thumbKey)]);
    if (error instanceof PhotoWriteError) return { ok: false, code: error.code } as const;
    throw error;
  }
  return { ok: true, id, thumbUrl: `/taller/media/${keys.thumbKey}` } as const;
}

type UploadContext = {
  db: AppDb;
  storage: ObjectStorage;
  actor: SessionUser | null;
  orderId: string;
  now: Date;
};

export async function handlePhotoUpload(request: Request, ctx: UploadContext): Promise<Response> {
  if (!ctx.actor) return photoError(401, "unauthorized");
  if (!isAllowedOrigin(request)) return photoError(403, "forbidden");
  if (Number(request.headers.get("content-length")) > 16 * 1024 * 1024)
    return photoError(413, "too_large");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return photoError(422, "validation_error");
  }
  const parsed = uploadFormSchema.safeParse({
    orderId: ctx.orderId,
    etapa: form.get("etapa"),
    foto: form.get("foto"),
  });
  if (!parsed.success) return photoError(422, "validation_error");
  const { foto, etapa } = parsed.data;
  if (foto.size > MAX_PHOTO_BYTES) return photoError(413, "too_large");
  if (!foto.type.startsWith("image/")) return photoError(415, "invalid_image");
  try {
    const result = await uploadOrderPhoto(
      ctx.db,
      ctx.storage,
      ctx.actor,
      {
        orderId: parsed.data.orderId,
        stage: etapa,
        bytes: Buffer.from(await foto.arrayBuffer()),
      },
      ctx.now,
    );
    if (!result.ok) {
      return photoError(photoStatuses[result.code], result.code);
    }
    return jsonResponse(201, { id: result.id, thumbUrl: result.thumbUrl });
  } catch (error) {
    log.error("photos.upload_failed", { message: errorMessage(error) });
    return photoError(500, "internal_error");
  }
}

export async function listOrderPhotos(db: AppDb, actor: SessionUser, orderId: string) {
  if (!can(actor.role, "photos.upload") || !z.uuid().safeParse(orderId).success) return [];
  const header = await getOrderHeader(db, actor, orderId);
  if (!header || header.order.voidedAt || !canAccessPhotoOrder(actor, header.order)) return [];
  const rows = await db
    .select()
    .from(orderPhotos)
    .where(
      and(
        eq(orderPhotos.branchId, actor.branchId),
        eq(orderPhotos.workOrderId, orderId),
        isNull(orderPhotos.voidedAt),
      ),
    )
    .orderBy(asc(orderPhotos.stage), asc(orderPhotos.createdAt), asc(orderPhotos.id));
  return rows.map((row) => ({
    ...row,
    thumbUrl: `/taller/media/${row.thumbKey}`,
    fullUrl: row.fullPurgedAt ? null : `/taller/media/${row.fullKey}`,
  }));
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const mediaKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^orders/${uuidPattern}/(?:${uuidPattern}-(full|thumb)\\.jpg|signature-(recepcion|entrega)-${uuidPattern}\\.png)$`,
    ),
  )
  .refine(isStorageKey);

async function mediaOrderId(db: AppDb, actor: SessionUser, key: string) {
  if (key.endsWith(".png")) {
    const [signature] = await db
      .select({ workOrderId: orderSignatures.workOrderId })
      .from(orderSignatures)
      .where(and(eq(orderSignatures.branchId, actor.branchId), eq(orderSignatures.storageKey, key)))
      .limit(1);
    return signature?.workOrderId ?? null;
  }
  const [photo] = await db
    .select()
    .from(orderPhotos)
    .where(
      and(
        eq(orderPhotos.branchId, actor.branchId),
        isNull(orderPhotos.voidedAt),
        or(eq(orderPhotos.fullKey, key), eq(orderPhotos.thumbKey, key)),
      ),
    )
    .limit(1);
  if (!photo || (key === photo.fullKey && photo.fullPurgedAt)) return null;
  return photo.workOrderId;
}

export async function handleMediaRequest(
  db: AppDb,
  storage: ObjectStorage,
  actor: SessionUser | null,
  key: string,
): Promise<Response> {
  if (!actor) return photoError(401, "unauthorized");
  if (!can(actor.role, "photos.upload")) return photoError(403, "forbidden");
  if (!mediaKeySchema.safeParse(key).success) return photoError(404, "not_found");
  const orderId = await mediaOrderId(db, actor, key);
  if (!orderId) return photoError(404, "not_found");
  const header = await getOrderHeader(db, actor, orderId);
  if (!header || header.order.voidedAt) return photoError(404, "not_found");
  if (!canAccessPhotoOrder(actor, header.order)) return photoError(403, "forbidden");
  const body = await storage.get(key);
  if (body === null) return photoError(404, "not_found");
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": key.endsWith(".png") ? "image/png" : "image/jpeg",
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
