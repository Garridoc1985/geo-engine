import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { BIKE_TYPES } from "./rules.ts";

function optionalText(max: number, message: string) {
  return z
    .string({ error: "Ingresa un texto válido." })
    .trim()
    .max(max, message)
    .nullable()
    .default(null)
    .transform((value) => value || null);
}

function optionalInteger(min: number, max: number, message: string) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return value;
    return value.trim() === "" ? null : Number(value);
  }, z.number({ error: message }).int(message).min(min, message).max(max, message).nullable());
}

export const bikeFormSchema = z.object({
  brand: z
    .string({ error: "Ingresa la marca." })
    .trim()
    .min(1, "Ingresa la marca.")
    .max(60, "La marca no puede superar los 60 caracteres."),
  model: z
    .string({ error: "Ingresa el modelo." })
    .trim()
    .min(1, "Ingresa el modelo.")
    .max(80, "El modelo no puede superar los 80 caracteres."),
  year: optionalInteger(1980, 2100, "Ingresa un año entero entre 1980 y 2100."),
  bikeType: z.enum(BIKE_TYPES, { error: "Selecciona un tipo de bicicleta válido." }),
  size: optionalText(20, "La talla no puede superar los 20 caracteres."),
  color: optionalText(40, "El color no puede superar los 40 caracteres."),
  serialNumber: optionalText(80, "El número de serie no puede superar los 80 caracteres."),
  kmNoted: optionalInteger(0, 2147483647, "Ingresa un kilometraje entero entre 0 y 2147483647."),
  notes: optionalText(1000, "Las notas no pueden superar los 1000 caracteres."),
});

export type Bike = typeof bikes.$inferSelect;
export type BikeInput = z.infer<typeof bikeFormSchema>;
type BikeResult =
  | { ok: true; bike: Bike }
  | { ok: false; code: "forbidden" | "not_found" | "validation_error" };

function bikeScope(branchId: string, id: string) {
  return and(eq(bikes.branchId, branchId), eq(bikes.id, id));
}

export async function insertBike(
  db: AppDb,
  branchId: string,
  customerId: string,
  input: unknown,
  now: Date,
): Promise<BikeResult> {
  const parsed = bikeFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" };
  const [customer] = await db
    .select({ branchId: customers.branchId })
    .from(customers)
    .where(and(eq(customers.branchId, branchId), eq(customers.id, customerId)))
    .limit(1);
  if (!customer) return { ok: false, code: "not_found" };
  const [bike] = await db
    .insert(bikes)
    .values({
      ...parsed.data,
      branchId: customer.branchId,
      customerId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!bike) throw new Error("No se pudo guardar la bicicleta.");
  return { ok: true, bike };
}

export async function createBike(
  db: AppDb,
  actor: SessionUser,
  customerId: string,
  input: unknown,
  now: Date,
): Promise<BikeResult> {
  if (!can(actor.role, "customers.manage")) return { ok: false, code: "forbidden" };
  return insertBike(db, actor.branchId, customerId, input, now);
}

export async function updateBike(
  db: AppDb,
  actor: SessionUser,
  id: string,
  input: unknown,
  now: Date,
): Promise<BikeResult> {
  if (!can(actor.role, "customers.manage")) return { ok: false, code: "forbidden" };
  const parsed = bikeFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" };
  const [bike] = await db
    .update(bikes)
    .set({ ...parsed.data, updatedAt: now })
    .where(bikeScope(actor.branchId, id))
    .returning();
  return bike ? { ok: true, bike } : { ok: false, code: "not_found" };
}

export async function getBike(db: AppDb, actor: SessionUser, id: string) {
  const [bike] = await db.select().from(bikes).where(bikeScope(actor.branchId, id)).limit(1);
  return bike ?? null;
}

export function listBikesOfCustomer(db: AppDb, actor: SessionUser, customerId: string) {
  return db
    .select()
    .from(bikes)
    .where(and(eq(bikes.branchId, actor.branchId), eq(bikes.customerId, customerId)))
    .orderBy(asc(bikes.createdAt), asc(bikes.id));
}
