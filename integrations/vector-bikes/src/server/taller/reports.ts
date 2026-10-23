import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import {
  bikeComponents,
  intakeChecks,
  orderPhotos,
  workOrderApprovals,
  workOrderItems,
  workOrders,
} from "../db/schema-orders.ts";
import { serviceReports } from "../db/schema-reports.ts";
import { bikes, customers, services } from "../db/schema-taller.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import { recordAudit } from "./audit.ts";
import { formatOrderNumber } from "./orders.ts";
import { INTAKE_CHECK_LABELS } from "./rules.ts";
import { hashShareToken, newShareToken, shareTokenSchema } from "./share-tokens.ts";
import { canAccessOrder } from "./status.ts";

export const reportFormSchema = z.strictObject({
  recommendations: z.string().trim().max(2000),
  nextChecks: z.string().trim().max(2000),
});
type ReportInput = z.infer<typeof reportFormSchema>;
const photoSchema = z.strictObject({ photoId: z.uuid(), thumbKey: z.string() });
const nullableText = z.string().nullable();
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  orderNumber: z.string(),
  customerFirstName: z.string(),
  bike: z.strictObject({
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
    type: z.string(),
    size: nullableText,
    color: nullableText,
    serialNumber: nullableText,
    kmNoted: z.number().int().nullable(),
  }),
  receivedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  diagnosis: nullableText,
  workDone: z.array(z.strictObject({ description: z.string(), quantity: z.number().int() })),
  problemsFound: z.array(
    z.strictObject({
      item: z.string(),
      result: z.enum(["revisar", "malo"]),
      note: nullableText,
    }),
  ),
  componentsReplaced: z.array(
    z.strictObject({
      componentType: z.string(),
      brand: z.string(),
      model: z.string(),
      replaces: nullableText,
    }),
  ),
  photosBefore: z.array(photoSchema),
  photosAfter: z.array(photoSchema),
  recommendations: z.string(),
  nextChecks: z.string(),
  rejectedWork: z.array(
    z.strictObject({
      description: z.string(),
      recommendation: z.string(),
      decidedAt: z.iso.datetime(),
    }),
  ),
  totalClp: z.number().int(),
});
export type ReportSnapshot = z.infer<typeof snapshotSchema>;
type ReportOrder = typeof workOrders.$inferSelect;

function orderFilter(branchId: string, orderId: string) {
  return and(
    eq(workOrders.branchId, branchId),
    eq(workOrders.id, orderId),
    isNull(workOrders.voidedAt),
  );
}

async function accessOrder(db: AppDb, actor: SessionUser, orderId: string, lock = false) {
  const query = db.select().from(workOrders).where(orderFilter(actor.branchId, orderId));
  const [order] = await (lock ? query.for("update") : query);
  return order && canAccessOrder(actor, order) ? order : null;
}

async function reportIdentity(db: AppDb, order: ReportOrder) {
  const [identity] = await db
    .select({
      customerName: customers.name,
      bike: {
        brand: bikes.brand,
        model: bikes.model,
        year: bikes.year,
        type: bikes.bikeType,
        size: bikes.size,
        color: bikes.color,
        serialNumber: bikes.serialNumber,
        kmNoted: bikes.kmNoted,
      },
    })
    .from(bikes)
    .innerJoin(
      customers,
      and(eq(customers.id, order.customerId), eq(customers.branchId, order.branchId)),
    )
    .where(and(eq(bikes.id, order.bikeId), eq(bikes.branchId, order.branchId)));
  if (!identity) throw new Error("No se encontraron los datos de la bicicleta y el cliente.");
  return {
    bike: identity.bike,
    customerFirstName: identity.customerName.trim().split(/\s+/)[0] ?? "",
  };
}

async function reportWork(db: AppDb, order: ReportOrder) {
  const workDone = await db
    .select({ description: workOrderItems.description, quantity: workOrderItems.quantity })
    .from(workOrderItems)
    .where(
      and(
        eq(workOrderItems.branchId, order.branchId),
        eq(workOrderItems.workOrderId, order.id),
        isNull(workOrderItems.voidedAt),
      ),
    )
    .orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id));
  const checks = await db
    .select({ item: intakeChecks.itemKey, result: intakeChecks.result, note: intakeChecks.note })
    .from(intakeChecks)
    .where(
      and(
        eq(intakeChecks.branchId, order.branchId),
        eq(intakeChecks.workOrderId, order.id),
        inArray(intakeChecks.result, ["revisar", "malo"]),
      ),
    )
    .orderBy(asc(intakeChecks.itemKey));
  const problemsFound = checks.map((check) => ({
    ...check,
    item: INTAKE_CHECK_LABELS[check.item as keyof typeof INTAKE_CHECK_LABELS],
  }));
  return { workDone, problemsFound };
}

async function reportComponents(db: AppDb, order: ReportOrder) {
  const previous = alias(bikeComponents, "previous_component");
  const rows = await db
    .select({
      componentType: bikeComponents.componentType,
      brand: bikeComponents.brand,
      model: bikeComponents.model,
      previousType: previous.componentType,
      previousBrand: previous.brand,
      previousModel: previous.model,
    })
    .from(bikeComponents)
    .leftJoin(
      previous,
      and(
        eq(previous.replacedByComponentId, bikeComponents.id),
        eq(previous.branchId, order.branchId),
        eq(previous.bikeId, order.bikeId),
        isNull(previous.voidedAt),
      ),
    )
    .where(
      and(
        eq(bikeComponents.branchId, order.branchId),
        eq(bikeComponents.workOrderId, order.id),
        eq(bikeComponents.bikeId, order.bikeId),
        isNull(bikeComponents.voidedAt),
      ),
    )
    .orderBy(asc(bikeComponents.createdAt), asc(bikeComponents.id));
  return rows.map(({ previousType, previousBrand, previousModel, ...component }) => ({
    ...component,
    replaces: previousType ? `${previousType} ${previousBrand} ${previousModel}` : null,
  }));
}

async function reportPhotos(db: AppDb, order: ReportOrder) {
  const rows = await db
    .select({ photoId: orderPhotos.id, thumbKey: orderPhotos.thumbKey, stage: orderPhotos.stage })
    .from(orderPhotos)
    .where(
      and(
        eq(orderPhotos.branchId, order.branchId),
        eq(orderPhotos.workOrderId, order.id),
        isNull(orderPhotos.voidedAt),
        inArray(orderPhotos.stage, ["recepcion", "terminado"]),
      ),
    )
    .orderBy(asc(orderPhotos.createdAt), asc(orderPhotos.id));
  const atStage = (stage: string) =>
    rows
      .filter((photo) => photo.stage === stage)
      .map(({ photoId, thumbKey }) => ({ photoId, thumbKey }));
  return { photosBefore: atStage("recepcion"), photosAfter: atStage("terminado") };
}

async function reportRejectedWork(db: AppDb, order: ReportOrder) {
  const rows = await db
    .select({
      description: workOrderApprovals.description,
      recommendation: workOrderApprovals.recommendation,
      decidedAt: workOrderApprovals.decidedAt,
    })
    .from(workOrderApprovals)
    .where(
      and(
        eq(workOrderApprovals.branchId, order.branchId),
        eq(workOrderApprovals.workOrderId, order.id),
        eq(workOrderApprovals.decision, "rechazado"),
        isNull(workOrderApprovals.voidedAt),
      ),
    )
    .orderBy(asc(workOrderApprovals.decidedAt), asc(workOrderApprovals.id));
  return rows.map((row) => ({ ...row, decidedAt: row.decidedAt?.toISOString() }));
}

async function snapshotOfOrder(
  db: AppDb,
  order: ReportOrder,
  input: ReportInput,
): Promise<ReportSnapshot> {
  return snapshotSchema.parse({
    version: 1,
    orderNumber: formatOrderNumber(order.number),
    ...(await reportIdentity(db, order)),
    receivedAt: order.receivedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    diagnosis: order.diagnosis,
    ...(await reportWork(db, order)),
    componentsReplaced: await reportComponents(db, order),
    ...(await reportPhotos(db, order)),
    ...input,
    rejectedWork: await reportRejectedWork(db, order),
    totalClp: order.totalClp,
  });
}

// Sin actor en este contrato: la orden determina la sucursal de todas sus relaciones.
export async function buildReportSnapshot(db: AppDb, orderId: string, input: ReportInput) {
  const id = z.uuid().safeParse(orderId);
  const fields = reportFormSchema.parse(input);
  if (!id.success) return null;
  const [order] = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, id.data), isNull(workOrders.voidedAt)));
  return order ? snapshotOfOrder(db, order, fields) : null;
}

async function auditReport(db: AppDb, actor: SessionUser, orderId: string, now: Date) {
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: "report.generated",
      entity: "work_order",
      entityId: orderId,
      details: {},
    },
    now,
  );
}

async function saveReport(
  db: AppDb,
  actor: SessionUser,
  order: ReportOrder,
  input: ReportInput,
  now: Date,
) {
  const snapshot = await snapshotOfOrder(db, order, input);
  const token = newShareToken();
  const fields = {
    snapshot,
    shareTokenHash: hashShareToken(token),
    generatedAt: now,
    generatedBy: actor.id,
    updatedAt: now,
  };
  await db
    .insert(serviceReports)
    .values({
      ...fields,
      branchId: actor.branchId,
      workOrderId: order.id,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: serviceReports.workOrderId,
      set: fields,
      setWhere: eq(serviceReports.branchId, actor.branchId),
    });
  await auditReport(db, actor, order.id, now);
  return { ok: true, token } as const;
}

export async function generateReport(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "reports.generate")) return { ok: false, code: "forbidden" } as const;
  const parsed = reportFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  if (!z.uuid().safeParse(orderId).success) return { ok: false, code: "not_found" } as const;
  return db.transaction(async (tx) => {
    const order = await accessOrder(tx, actor, orderId, true);
    if (!order) return { ok: false, code: "not_found" } as const;
    if (!["lista_para_retirar", "entregada"].includes(order.status))
      return { ok: false, code: "invalid_status" } as const;
    return saveReport(tx, actor, order, parsed.data, now);
  });
}

export async function getReportForStaff(db: AppDb, actor: SessionUser, orderId: string) {
  if (!can(actor.role, "reports.generate") || !z.uuid().safeParse(orderId).success) return null;
  if (!(await accessOrder(db, actor, orderId))) return null;
  const [report] = await db
    .select({ snapshot: serviceReports.snapshot, generatedAt: serviceReports.generatedAt })
    .from(serviceReports)
    .where(
      and(eq(serviceReports.branchId, actor.branchId), eq(serviceReports.workOrderId, orderId)),
    );
  return report ? { ...report, snapshot: snapshotSchema.parse(report.snapshot) } : null;
}

export async function getReportAftercare(db: AppDb, actor: SessionUser, orderId: string) {
  if (!can(actor.role, "reports.generate") || !z.uuid().safeParse(orderId).success) return "";
  if (!(await accessOrder(db, actor, orderId))) return "";
  const rows = await db
    .select({ aftercare: services.aftercare })
    .from(workOrderItems)
    .innerJoin(
      services,
      and(eq(services.id, workOrderItems.serviceId), eq(services.branchId, actor.branchId)),
    )
    .where(
      and(
        eq(workOrderItems.branchId, actor.branchId),
        eq(workOrderItems.workOrderId, orderId),
        eq(workOrderItems.kind, "servicio"),
        isNull(workOrderItems.voidedAt),
      ),
    )
    .orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id));
  return [...new Set(rows.map((row) => row.aftercare?.trim()).filter(Boolean))].join("\n\n");
}

export async function loadReportPhotos(
  storage: ObjectStorage,
  snapshot: ReportSnapshot,
): Promise<Record<string, string>> {
  const photos: Record<string, string> = {};
  for (const { photoId, thumbKey } of [...snapshot.photosBefore, ...snapshot.photosAfter]) {
    const body = await storage.get(thumbKey);
    if (body) photos[photoId] = `data:image/jpeg;base64,${body.toString("base64")}`;
  }
  return photos;
}

export async function viewReportByToken(
  db: AppDb,
  storage: ObjectStorage,
  token: string,
): Promise<{ snapshot: ReportSnapshot; photos: Record<string, string> } | null> {
  const parsed = shareTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  // Lectura pública: el token es la credencial y determina el informe, sin sesión ni sucursal.
  const [report] = await db
    .select({ snapshot: serviceReports.snapshot })
    .from(serviceReports)
    .where(eq(serviceReports.shareTokenHash, hashShareToken(parsed.data)));
  if (!report) return null;
  const snapshot = snapshotSchema.parse(report.snapshot);
  return { snapshot, photos: await loadReportPhotos(storage, snapshot) };
}
