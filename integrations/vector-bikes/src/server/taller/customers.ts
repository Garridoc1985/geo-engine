import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeRut } from "../../lib/rut.ts";
import { normalizePhone } from "../api/handlers.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { isUniqueViolation } from "../db/client.ts";
import type { AppDb } from "../db/client.ts";
import { customers } from "../db/schema-taller.ts";
import { branches } from "../db/schema.ts";
import { DISCOVERY_CHANNELS } from "./rules.ts";

const optionalString = z
  .string({ error: "Ingresa un texto válido." })
  .trim()
  .nullable()
  .default(null)
  .transform((value) => value || null);
export const customerFormSchema = z.object({
  name: z
    .string({ error: "Ingresa el nombre del cliente." })
    .trim()
    .min(2, "El nombre debe tener al menos 2 caracteres.")
    .max(120, "El nombre no puede superar los 120 caracteres."),
  phoneE164: z
    .string({ error: "Ingresa un teléfono válido." })
    .transform(normalizePhone)
    .refine(
      (value): value is string => value !== null,
      "Ingresa un teléfono celular chileno válido.",
    )
    .pipe(z.string({ error: "Ingresa un teléfono celular chileno válido." })),
  rut: optionalString
    .refine((value) => value === null || normalizeRut(value) !== null, "Ingresa un RUT válido.")
    .transform((value) => (value === null ? null : normalizeRut(value))),
  email: optionalString.pipe(z.email({ error: "Ingresa un correo válido." }).nullable()),
  discoveryChannel: optionalString.pipe(
    z.enum(DISCOVERY_CHANNELS, { error: "Selecciona un canal válido." }).nullable(),
  ),
  notes: optionalString.pipe(
    z.string().max(2000, "Las notas no pueden superar los 2000 caracteres.").nullable(),
  ),
});

export type Customer = typeof customers.$inferSelect;
export type CustomerInput = z.infer<typeof customerFormSchema>;
type CustomerHit = Pick<Customer, "id" | "name">;
type DuplicateResult = { ok: false; code: "duplicate"; existing: CustomerHit | null };
type InsertResult = { ok: true; customer: Customer } | DuplicateResult;
type CustomerResult = InsertResult | { ok: false; code: "forbidden" | "not_found" };
type DuplicateInput = Pick<CustomerInput, "phoneE164" | "rut">;
type CustomerOptions = { allowPhoneDuplicate?: boolean };

class PhoneDuplicateError extends Error {
  existing: CustomerHit;

  constructor(existing: CustomerHit) {
    super("El teléfono ya tiene una ficha.");
    this.existing = existing;
  }
}

function customerScope(branchId: string, id: string) {
  return and(eq(customers.branchId, branchId), eq(customers.id, id));
}

async function duplicatesInBranch(
  db: AppDb,
  branchId: string,
  input: DuplicateInput,
  excludeId?: string,
) {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phoneE164: customers.phoneE164,
      rut: customers.rut,
    })
    .from(customers)
    .where(
      and(
        eq(customers.branchId, branchId),
        excludeId ? ne(customers.id, excludeId) : undefined,
        or(
          eq(customers.phoneE164, input.phoneE164),
          input.rut ? eq(customers.rut, input.rut) : undefined,
        ),
      ),
    )
    .orderBy(asc(customers.createdAt), asc(customers.id));
  const hit = (row: (typeof rows)[number] | undefined): CustomerHit | null =>
    row ? { id: row.id, name: row.name } : null;
  return {
    rut: hit(input.rut ? rows.find((row) => row.rut === input.rut) : undefined),
    phone: hit(rows.find((row) => row.phoneE164 === input.phoneE164)),
  };
}

export function findDuplicates(db: AppDb, branchId: string, input: DuplicateInput) {
  return duplicatesInBranch(db, branchId, input);
}

function duplicate(existing: CustomerHit | null): DuplicateResult {
  return { ok: false, code: "duplicate", existing };
}

async function rutConflict(
  db: AppDb,
  branchId: string,
  rut: string | null,
): Promise<DuplicateResult> {
  if (rut === null) return duplicate(null);
  const [existing] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(and(eq(customers.branchId, branchId), eq(customers.rut, rut)))
    .limit(1);
  return duplicate(existing ?? null);
}

function isRutViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const detail = current as { constraint?: string; constraint_name?: string; cause?: unknown };
    if (detail.constraint === "uq_customers_rut" || detail.constraint_name === "uq_customers_rut") {
      return true;
    }
    current = detail.cause;
  }
  return false;
}

function customerValues(input: CustomerInput, now: Date) {
  return {
    name: input.name,
    phoneE164: input.phoneE164,
    rut: input.rut,
    email: input.email,
    discoveryChannel: input.discoveryChannel,
    notes: input.notes,
    updatedAt: now,
  };
}

async function lockBranch(db: AppDb, branchId: string) {
  await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, branchId))
    .for("update");
}

async function insertInBranch(
  db: AppDb,
  branchId: string,
  input: CustomerInput,
  now: Date,
  allowPhoneDuplicate: boolean,
): Promise<InsertResult> {
  const existing = await findDuplicates(db, branchId, input);
  if (existing.rut) return duplicate(existing.rut);
  const phoneDuplicate = allowPhoneDuplicate ? null : existing.phone;
  if (phoneDuplicate && input.rut === null) return duplicate(phoneDuplicate);
  const [customer] = await db
    .insert(customers)
    .values({ ...customerValues(input, now), branchId, createdAt: now })
    // También funciona dentro de la transacción de recepción sin abortarla por el RUT.
    .onConflictDoNothing({ target: customers.rut, where: sql`rut is not null` })
    .returning();
  if (!customer) return rutConflict(db, branchId, input.rut);
  // Si hay ambos conflictos, prevalece el RUT global; el teléfono revierte la escritura.
  if (phoneDuplicate) throw new PhoneDuplicateError(phoneDuplicate);
  return { ok: true, customer };
}

export async function insertCustomer(
  db: AppDb,
  branchId: string,
  input: CustomerInput,
  now: Date,
  { allowPhoneDuplicate = false }: CustomerOptions = {},
): Promise<InsertResult> {
  try {
    return await db.transaction(async (tx) => {
      await lockBranch(tx, branchId);
      return insertInBranch(tx, branchId, input, now, allowPhoneDuplicate);
    });
  } catch (error) {
    if (error instanceof PhoneDuplicateError) return duplicate(error.existing);
    if (isRutViolation(error)) return rutConflict(db, branchId, input.rut);
    throw error;
  }
}

export async function createCustomer(
  db: AppDb,
  actor: SessionUser,
  input: CustomerInput,
  now: Date,
  options: CustomerOptions = {},
): Promise<CustomerResult> {
  if (!can(actor.role, "customers.manage")) return { ok: false, code: "forbidden" };
  return insertCustomer(db, actor.branchId, input, now, options);
}

export async function updateCustomer(
  db: AppDb,
  actor: SessionUser,
  id: string,
  input: CustomerInput,
  now: Date,
  { allowPhoneDuplicate = false }: CustomerOptions = {},
): Promise<CustomerResult> {
  if (!can(actor.role, "customers.manage")) return { ok: false, code: "forbidden" };
  try {
    return await db.transaction(async (tx): Promise<CustomerResult> => {
      await lockBranch(tx, actor.branchId);
      if (!(await getCustomer(tx, actor, id))) return { ok: false, code: "not_found" };
      const existing = await duplicatesInBranch(tx, actor.branchId, input, id);
      if (existing.rut) return duplicate(existing.rut);
      const phoneDuplicate = allowPhoneDuplicate ? null : existing.phone;
      if (phoneDuplicate && input.rut === null) return duplicate(phoneDuplicate);
      const [customer] = await tx
        .update(customers)
        .set(customerValues(input, now))
        .where(customerScope(actor.branchId, id))
        .returning();
      if (phoneDuplicate) throw new PhoneDuplicateError(phoneDuplicate);
      return customer ? { ok: true, customer } : { ok: false, code: "not_found" };
    });
  } catch (error) {
    if (error instanceof PhoneDuplicateError) return duplicate(error.existing);
    if (isRutViolation(error)) return rutConflict(db, actor.branchId, input.rut);
    throw error;
  }
}

export async function getCustomer(db: AppDb, actor: SessionUser, id: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(customerScope(actor.branchId, id))
    .limit(1);
  return customer ?? null;
}

export function listCustomers(db: AppDb, actor: SessionUser, limit = 50) {
  return db
    .select()
    .from(customers)
    .where(eq(customers.branchId, actor.branchId))
    .orderBy(desc(customers.createdAt), asc(customers.id))
    .limit(limit);
}

export async function findCustomerByPhone(db: AppDb, actor: SessionUser, phoneE164: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.branchId, actor.branchId), eq(customers.phoneE164, phoneE164)))
    .orderBy(asc(customers.createdAt), asc(customers.id))
    .limit(1);
  return customer ?? null;
}
