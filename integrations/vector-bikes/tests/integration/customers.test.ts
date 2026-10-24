import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { formatRut, normalizeRut } from "../../src/lib/rut.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { auditLog, customers } from "../../src/server/db/schema-taller.ts";
import { branches } from "../../src/server/db/schema.ts";
import {
  createCustomer,
  customerFormSchema,
  findCustomerByPhone,
  findDuplicates,
  getCustomer,
  insertCustomer,
  listCustomers,
  updateCustomer,
} from "../../src/server/taller/customers.ts";
import type { CustomerInput } from "../../src/server/taller/customers.ts";
import { DISCOVERY_CHANNELS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-05T15:00:00.000Z");
const LATER = new Date("2026-10-05T15:01:00.000Z");
const input = customerFormSchema.parse({ name: "Cliente de prueba", phoneE164: "9 1234 5678" });

it.each([
  ["12.345.678-5", "12345678-5"],
  ["123456785", "12345678-5"],
  ["10.000.013-k", "10000013-K"],
  ["12.345.675-0", "12345675-0"],
  [" 12 345 678 - 5 ", "12345678-5"],
  ["1.234.567-4", "1234567-4"],
])("1: normaliza %s con módulo 11", (raw, expected) => {
  expect(normalizeRut(raw)).toBe(expected);
});

it.each(["12.345.678-4", "12345678", "abc", "", "123456-0", "123456789-2", "12x345678-5"])(
  "2: rechaza el RUT inválido %s",
  (raw) => expect(normalizeRut(raw)).toBeNull(),
);

it.each([
  ["12345678-5", "12.345.678-5"],
  ["10000013-K", "10.000.013-K"],
  ["12345675-0", "12.345.675-0"],
  ["1234567-4", "1.234.567-4"],
])("agrega puntos al RUT normalizado %s", (normalized, formatted) => {
  expect(formatRut(normalized)).toBe(formatted);
  expect(normalizeRut(formatRut(normalized))).toBe(normalized);
});

it("valida los campos del formulario con mensajes en español", () => {
  for (const changes of [
    { name: "X" },
    { name: "X".repeat(121) },
    { phoneE164: "123" },
    { rut: "12.345.678-4" },
    { email: "invalido" },
    { discoveryChannel: "desconocido" },
    { notes: "x".repeat(2001) },
  ]) {
    const parsed = customerFormSchema.safeParse({ ...input, ...changes });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0]?.message).toMatch(/Ingresa|nombre|Selecciona|notas/);
  }
  expect(
    customerFormSchema.parse({ ...input, rut: " ", email: "", discoveryChannel: "", notes: "" }),
  ).toEqual(input);
  for (const discoveryChannel of DISCOVERY_CHANNELS) {
    expect(customerFormSchema.safeParse({ ...input, discoveryChannel }).success).toBe(true);
  }
});

let test: TestDb;
let owner: SessionUser;
let other: SessionUser;

async function actor(name: string): Promise<SessionUser> {
  const [branch] = await test.db.insert(branches).values({ name }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba");
  return {
    id: randomUUID(),
    branchId: branch.id,
    role: "owner",
    name: "Usuario",
    email: "test@ejemplo.cl",
  };
}

async function create(changes: Partial<CustomerInput> = {}, user = owner, now = NOW) {
  const result = await createCustomer(test.db, user, { ...input, ...changes }, now);
  if (!result.ok) throw new Error(`No se creó el cliente: ${result.code}`);
  return result.customer;
}

beforeEach(async () => {
  test = await createTestDb();
  owner = await actor("Vitacura");
  other = await actor("Otra sucursal");
  return () => test.close();
});

it("3: teléfono y RUT repetidos devuelven solo id y nombre sin insertar", async () => {
  const customer = await create({ rut: "12345678-5" });
  const expected = {
    ok: false,
    code: "duplicate",
    existing: { id: customer.id, name: customer.name },
  };
  expect(await createCustomer(test.db, owner, { ...input, name: "Otro cliente" }, NOW)).toEqual(
    expected,
  );
  expect(
    await createCustomer(
      test.db,
      owner,
      { ...input, phoneE164: "+56987654321", rut: customer.rut },
      NOW,
    ),
  ).toEqual(expected);
  expect(
    await findDuplicates(test.db, owner.branchId, {
      phoneE164: customer.phoneE164,
      rut: customer.rut,
    }),
  ).toEqual({ phone: expected.existing, rut: expected.existing });
  expect(await test.db.select().from(customers)).toHaveLength(1);
});

it("4: permite repetir teléfono con confirmación, pero nunca RUT", async () => {
  const first = await create({ rut: "12345678-5" });
  const retry = await createCustomer(test.db, owner, input, NOW, { allowPhoneDuplicate: true });
  expect(retry.ok).toBe(true);
  expect(
    await createCustomer(test.db, owner, { ...input, rut: first.rut }, NOW, {
      allowPhoneDuplicate: true,
    }),
  ).toEqual({ ok: false, code: "duplicate", existing: { id: first.id, name: first.name } });
  expect(await test.db.select().from(customers)).toHaveLength(2);
});

it("5: guarda RUT y teléfono normalizados, sucursal e instantes inyectados, sin auditoría", async () => {
  const parsed = customerFormSchema.parse({
    name: " Cliente de prueba ",
    phoneE164: "9 1234 5678",
    rut: "12.345.678-5",
    email: "test@ejemplo.cl",
    discoveryChannel: "google",
    notes: " Notas de prueba ",
  });
  const result = await createCustomer(test.db, owner, parsed, NOW);
  expect(result).toMatchObject({
    ok: true,
    customer: {
      ...parsed,
      branchId: owner.branchId,
      phoneE164: "+56912345678",
      rut: "12345678-5",
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  expect(await test.db.select().from(customers)).toEqual(result.ok ? [result.customer] : []);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("el RUT global de otra sucursal devuelve duplicate con existing null", async () => {
  await create({ rut: "12345678-5" });
  expect(await findDuplicates(test.db, other.branchId, { ...input, rut: "12345678-5" })).toEqual({
    phone: null,
    rut: null,
  });
  expect(await createCustomer(test.db, other, { ...input, rut: "12345678-5" }, NOW)).toEqual({
    ok: false,
    code: "duplicate",
    existing: null,
  });
  expect(await listCustomers(test.db, other)).toEqual([]);
  expect(await test.db.select().from(customers)).toHaveLength(1);
});

it("el RUT de otra sucursal prevalece sobre un teléfono duplicado local", async () => {
  await create({ rut: "12345678-5" }, other);
  const local = await create();
  const second = await create({ phoneE164: "+56987654321" });
  const conflicting = { ...input, rut: "12345678-5" };
  const expected = { ok: false, code: "duplicate", existing: null };
  expect(await createCustomer(test.db, owner, conflicting, LATER)).toEqual(expected);
  expect(await updateCustomer(test.db, owner, second.id, conflicting, LATER)).toEqual(expected);
  expect(await listCustomers(test.db, owner)).toHaveLength(2);
  expect(await getCustomer(test.db, owner, local.id)).toEqual(local);
  expect(await getCustomer(test.db, owner, second.id)).toEqual(second);
});

it("un RUT nuevo no permite repetir teléfono ni deja una escritura parcial", async () => {
  const customer = await create();
  expect(await createCustomer(test.db, owner, { ...input, rut: "12345678-5" }, LATER)).toEqual({
    ok: false,
    code: "duplicate",
    existing: { id: customer.id, name: customer.name },
  });
  expect(await listCustomers(test.db, owner)).toEqual([customer]);
});

it("resuelve la carrera de RUT sin insertar dos fichas", async () => {
  const results = await Promise.all([
    createCustomer(test.db, owner, { ...input, rut: "12345678-5" }, NOW),
    createCustomer(test.db, owner, { ...input, rut: "12345678-5", phoneE164: "+56987654321" }, NOW),
  ]);
  const winner = results.find((result) => result.ok);
  if (!winner?.ok) throw new Error("Falta el resultado exitoso");
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({
    ok: false,
    code: "duplicate",
    existing: { id: winner.customer.id, name: winner.customer.name },
  });
  expect(await test.db.select().from(customers)).toHaveLength(1);
});

it("insertCustomer se puede usar dentro de una transacción sin permiso de gestión", async () => {
  await create({ rut: "12345678-5" });
  await test.db.transaction(async (tx) => {
    expect(await insertCustomer(tx, other.branchId, { ...input, rut: "12345678-5" }, NOW)).toEqual({
      ok: false,
      code: "duplicate",
      existing: null,
    });
    expect((await insertCustomer(tx, other.branchId, input, NOW)).ok).toBe(true);
  });
  expect(await listCustomers(test.db, other)).toHaveLength(1);
});

it("dos creaciones concurrentes no repiten teléfono sin confirmación", async () => {
  const results = await Promise.all([
    createCustomer(test.db, owner, input, NOW),
    createCustomer(test.db, owner, { ...input, name: "Otro cliente" }, NOW),
  ]);
  const winner = results.find((result) => result.ok);
  if (!winner?.ok) throw new Error("Falta el resultado exitoso");
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({
    ok: false,
    code: "duplicate",
    existing: { id: winner.customer.id, name: winner.customer.name },
  });
  expect(await listCustomers(test.db, owner)).toHaveLength(1);
});

it("crear y editar concurrentemente no repite teléfono sin confirmación", async () => {
  const customer = await create({ phoneE164: "+56987654321" });
  const results = await Promise.all([
    createCustomer(test.db, owner, input, LATER),
    updateCustomer(test.db, owner, customer.id, input, LATER),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, code: "duplicate" });
  const rows = await listCustomers(test.db, owner);
  expect(rows.filter((row) => row.phoneE164 === input.phoneE164)).toHaveLength(1);
});

it("createCustomer y updateCustomer rechazan al mecánico sin cambios", async () => {
  const customer = await create();
  const mechanic = { ...owner, role: "mechanic" } as const;
  expect(await createCustomer(test.db, mechanic, input, NOW)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await updateCustomer(test.db, mechanic, customer.id, input, LATER)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await test.db.select().from(customers)).toEqual([customer]);
});

it.each(["admin", "reception"] as const)("%s puede crear y editar clientes", async (role) => {
  const user = { ...owner, role };
  const customer = await create({}, user);
  expect(
    await updateCustomer(test.db, user, customer.id, { ...input, name: "Cliente editado" }, LATER),
  ).toMatchObject({
    ok: true,
    customer: { name: "Cliente editado", updatedAt: LATER, createdAt: NOW },
  });
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("edita sin confundirse consigo mismo y mantiene las reglas de duplicado", async () => {
  const first = await create({ rut: "12345678-5" });
  const secondInput = { ...input, phoneE164: "+56987654321", rut: "10000013-K" };
  const second = await create(secondInput);
  expect((await updateCustomer(test.db, owner, second.id, secondInput, LATER)).ok).toBe(true);
  const expected = { ok: false, code: "duplicate", existing: { id: first.id, name: first.name } };
  const repeatedPhone = { ...secondInput, phoneE164: first.phoneE164 };
  expect(await updateCustomer(test.db, owner, second.id, repeatedPhone, LATER)).toEqual(expected);
  expect(
    (
      await updateCustomer(test.db, owner, second.id, repeatedPhone, LATER, {
        allowPhoneDuplicate: true,
      })
    ).ok,
  ).toBe(true);
  expect(
    await updateCustomer(test.db, owner, second.id, { ...secondInput, rut: first.rut }, LATER, {
      allowPhoneDuplicate: true,
    }),
  ).toEqual(expected);
  expect(await getCustomer(test.db, owner, second.id)).toMatchObject({
    rut: second.rut,
    phoneE164: first.phoneE164,
    createdAt: NOW,
    updatedAt: LATER,
  });
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("una edición con RUT de otra sucursal revierte y devuelve existing null", async () => {
  await create({ rut: "12345678-5" });
  const customer = await create({}, other);
  expect(
    await updateCustomer(test.db, other, customer.id, { ...input, rut: "12345678-5" }, LATER),
  ).toEqual({ ok: false, code: "duplicate", existing: null });
  expect(await getCustomer(test.db, other, customer.id)).toEqual(customer);
});

it("filtra lecturas, duplicados y ediciones por sucursal, con límite y orden recientes", async () => {
  const first = await create();
  const second = await create({ phoneE164: "+56987654321" }, owner, LATER);
  expect(await listCustomers(test.db, owner, 1)).toEqual([second]);
  expect(await listCustomers(test.db, owner)).toEqual([second, first]);
  expect(await getCustomer(test.db, other, first.id)).toBeNull();
  expect(await findCustomerByPhone(test.db, owner, input.phoneE164)).toEqual(first);
  expect(await findCustomerByPhone(test.db, other, input.phoneE164)).toBeNull();
  expect(await findDuplicates(test.db, other.branchId, input)).toEqual({
    phone: null,
    rut: null,
  });
  expect(await updateCustomer(test.db, other, first.id, input, LATER)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await updateCustomer(test.db, owner, randomUUID(), input, LATER)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await getCustomer(test.db, owner, first.id)).toEqual(first);
  expect((await create({}, other)).branchId).toBe(other.branchId);
});

it("la base exige sucursal, RUT global único y un canal permitido", async () => {
  const first = await create({ rut: "12345678-5" });
  for (const discoveryChannel of DISCOVERY_CHANNELS) {
    await test.db.update(customers).set({ discoveryChannel }).where(eq(customers.id, first.id));
  }
  await expect(
    test.client.query("update customers set branch_id = null where id = $1", [first.id]),
  ).rejects.toMatchObject({ code: "23502" });
  await expect(
    test.client.query("update customers set discovery_channel = 'invalido' where id = $1", [
      first.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    test.client.query("update customers set branch_id = $1 where id = $2", [
      randomUUID(),
      first.id,
    ]),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    test.db.insert(customers).values({ ...input, branchId: other.branchId, rut: first.rut }),
  ).rejects.toMatchObject({ cause: { code: "23505", constraint: "uq_customers_rut" } });
});
