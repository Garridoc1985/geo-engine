import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { isUniqueViolation } from "../db/client.ts";
import type { AppDb } from "../db/client.ts";
import { servicePrices, services } from "../db/schema-taller.ts";
import { recordAudit } from "./audit.ts";
import type { AuditAction } from "./audit.ts";
import { BIKE_TYPES } from "./rules.ts";
import type { BikeType } from "./rules.ts";

const optionalText = z
  .string()
  .trim()
  .max(1000)
  .nullable()
  .default(null)
  .transform((value) => value || null);
export const serviceFormSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).default(""),
  estimatedMinutes: z.coerce.number().int().min(5).max(1440),
  usualMaterials: optionalText,
  aftercare: optionalText,
  isActive: z.boolean().default(true),
});
export const priceFormSchema = z.object({
  serviceId: z.uuid(),
  bikeType: z.enum(BIKE_TYPES),
  priceClp: z
    .union([z.number(), z.string().trim().regex(/^\d+$/)])
    .transform(Number)
    .pipe(z.number().int().min(0).max(2147483647)),
});

const optionalPrice = z.preprocess((value) => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") return value;
  const amount = value.replace(/[$\s]/g, "");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(amount)) return value;
  return Number(amount.replace(/\./g, ""));
}, z.number().int().min(0).max(2147483647).nullable());
export const pricesFormSchema = z.object({
  serviceId: z.uuid(),
  prices: z.object({
    mtb: optionalPrice,
    ruta: optionalPrice,
    gravel: optionalPrice,
    urbana: optionalPrice,
    ebike: optionalPrice,
  }),
});

type ServiceInput = z.infer<typeof serviceFormSchema>;
type PriceInput = z.infer<typeof priceFormSchema>;
type PricesInput = z.infer<typeof pricesFormSchema>;
type Service = typeof services.$inferSelect;
type CatalogResult =
  | { ok: true; serviceId: string }
  | { ok: false; code: "forbidden" | "not_found" | "name_taken" };
const SERVICE_FIELDS = [
  "name",
  "description",
  "estimatedMinutes",
  "usualMaterials",
  "aftercare",
  "isActive",
] as const;

function serviceScope(actor: SessionUser, serviceId: string) {
  return and(eq(services.branchId, actor.branchId), eq(services.id, serviceId));
}

function priceScope(actor: SessionUser, serviceId: string, bikeType?: BikeType) {
  return and(
    eq(servicePrices.branchId, actor.branchId),
    eq(servicePrices.serviceId, serviceId),
    bikeType ? eq(servicePrices.bikeType, bikeType) : undefined,
  );
}

export async function listCatalog(db: AppDb, actor: SessionUser) {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.branchId, actor.branchId))
    .orderBy(asc(services.name), asc(services.id));
  const prices = await db
    .select()
    .from(servicePrices)
    .innerJoin(services, eq(services.id, servicePrices.serviceId))
    .where(and(eq(servicePrices.branchId, actor.branchId), eq(services.branchId, actor.branchId)));
  return rows.map((service) => ({
    ...service,
    prices: Object.fromEntries(
      prices
        .filter((row) => row.service_prices.serviceId === service.id)
        .map((row) => [row.service_prices.bikeType, row.service_prices.priceClp]),
    ) as Partial<Record<BikeType, number>>,
  }));
}

export async function getService(db: AppDb, actor: SessionUser, serviceId: string) {
  const [service] = await db.select().from(services).where(serviceScope(actor, serviceId)).limit(1);
  if (!service) return null;
  const prices = await db.select().from(servicePrices).where(priceScope(actor, serviceId));
  return {
    ...service,
    prices: Object.fromEntries(prices.map((row) => [row.bikeType, row.priceClp])) as Partial<
      Record<BikeType, number>
    >,
  };
}

export async function priceFor(
  db: AppDb,
  actor: SessionUser,
  serviceId: string,
  bikeType: BikeType,
): Promise<number | null> {
  const [price] = await db
    .select({ priceClp: servicePrices.priceClp })
    .from(servicePrices)
    .innerJoin(services, eq(services.id, servicePrices.serviceId))
    .where(and(serviceScope(actor, serviceId), priceScope(actor, serviceId, bikeType)))
    .limit(1);
  return price?.priceClp ?? null;
}

async function auditCatalog(
  db: AppDb,
  actor: SessionUser,
  serviceId: string,
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
      entity: "services",
      entityId: serviceId,
      details,
    },
    now,
  );
}

export async function createService(
  db: AppDb,
  actor: SessionUser,
  input: ServiceInput,
  now: Date,
  prices?: Record<BikeType, number | null>,
): Promise<CatalogResult> {
  if (!can(actor.role, "catalog.edit")) return { ok: false, code: "forbidden" };
  try {
    return await db.transaction(async (tx) => {
      const [service] = await tx
        .insert(services)
        .values({
          ...input,
          branchId: actor.branchId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: services.id });
      if (!service) throw new Error("No se pudo crear el servicio");
      await auditCatalog(
        tx,
        actor,
        service.id,
        "catalog.service_created",
        { serviceId: service.id, fields: [...SERVICE_FIELDS] },
        now,
      );
      if (prices) await writeServicePrices(tx, actor, { serviceId: service.id, prices }, now);
      return { ok: true, serviceId: service.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "name_taken" };
    throw error;
  }
}

async function lockService(
  db: AppDb,
  actor: SessionUser,
  serviceId: string,
): Promise<Service | undefined> {
  const [service] = await db
    .select()
    .from(services)
    .where(serviceScope(actor, serviceId))
    .for("update");
  return service;
}

export async function updateService(
  db: AppDb,
  actor: SessionUser,
  serviceId: string,
  input: ServiceInput,
  now: Date,
): Promise<CatalogResult> {
  if (!can(actor.role, "catalog.edit")) return { ok: false, code: "forbidden" };
  try {
    return await db.transaction(async (tx) => {
      const before = await lockService(tx, actor, serviceId);
      if (!before) return { ok: false, code: "not_found" };
      const fields = SERVICE_FIELDS.filter((field) => before[field] !== input[field]);
      if (fields.length > 0) {
        await tx
          .update(services)
          .set({ ...input, updatedAt: now })
          .where(serviceScope(actor, serviceId));
        await auditCatalog(
          tx,
          actor,
          serviceId,
          "catalog.service_updated",
          { serviceId, fields },
          now,
        );
      }
      return { ok: true, serviceId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "name_taken" };
    throw error;
  }
}

async function upsertPrice(db: AppDb, actor: SessionUser, input: PriceInput, now: Date) {
  await db
    .insert(servicePrices)
    .values({
      ...input,
      branchId: actor.branchId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [servicePrices.serviceId, servicePrices.bikeType],
      set: { priceClp: input.priceClp, updatedAt: now },
      setWhere: eq(servicePrices.branchId, actor.branchId),
    });
}

export async function setServicePrice(
  db: AppDb,
  actor: SessionUser,
  input: PriceInput,
  now: Date,
): Promise<CatalogResult> {
  if (!can(actor.role, "catalog.edit")) return { ok: false, code: "forbidden" };
  return db.transaction(async (tx) => {
    const service = await lockService(tx, actor, input.serviceId);
    if (!service) return { ok: false, code: "not_found" };
    const before = await priceFor(tx, actor, input.serviceId, input.bikeType);
    await upsertPrice(tx, actor, input, now);
    await auditCatalog(
      tx,
      actor,
      input.serviceId,
      "catalog.price_changed",
      {
        serviceId: input.serviceId,
        bikeType: input.bikeType,
        before,
        after: input.priceClp,
      },
      now,
    );
    return { ok: true, serviceId: input.serviceId };
  });
}

async function writeServicePrices(db: AppDb, actor: SessionUser, input: PricesInput, now: Date) {
  const rows = await db.select().from(servicePrices).where(priceScope(actor, input.serviceId));
  for (const bikeType of BIKE_TYPES) {
    const before = rows.find((row) => row.bikeType === bikeType)?.priceClp ?? null;
    const after = input.prices[bikeType];
    if (before === after) continue;
    if (after === null) {
      await db.delete(servicePrices).where(priceScope(actor, input.serviceId, bikeType));
    } else {
      await upsertPrice(db, actor, { serviceId: input.serviceId, bikeType, priceClp: after }, now);
    }
    await auditCatalog(
      db,
      actor,
      input.serviceId,
      "catalog.price_changed",
      { serviceId: input.serviceId, bikeType, before, after },
      now,
    );
  }
}

export async function setServicePrices(
  db: AppDb,
  actor: SessionUser,
  input: PricesInput,
  now: Date,
): Promise<CatalogResult> {
  if (!can(actor.role, "catalog.edit")) return { ok: false, code: "forbidden" };
  return db.transaction(async (tx) => {
    const service = await lockService(tx, actor, input.serviceId);
    if (!service) return { ok: false, code: "not_found" };
    await writeServicePrices(tx, actor, input, now);
    return { ok: true, serviceId: input.serviceId };
  });
}
