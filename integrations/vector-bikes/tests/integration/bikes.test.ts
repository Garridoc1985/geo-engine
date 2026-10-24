import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { auditLog, bikes } from "../../src/server/db/schema-taller.ts";
import { branches } from "../../src/server/db/schema.ts";
import {
  bikeFormSchema,
  createBike,
  getBike,
  insertBike,
  listBikesOfCustomer,
  updateBike,
} from "../../src/server/taller/bikes.ts";
import { createCustomer, customerFormSchema } from "../../src/server/taller/customers.ts";
import { BIKE_TYPES } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-07T15:00:00.000Z");
const LATER = new Date("2026-10-07T15:01:00.000Z");
const input = bikeFormSchema.parse({ brand: "Trek", model: "Marlin", bikeType: "mtb" });
let test: TestDb;
let owner: SessionUser;
let other: SessionUser;
let customerId: string;
let otherCustomerId: string;

async function actor(name: string): Promise<SessionUser> {
  const [branch] = await test.db.insert(branches).values({ name }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  return {
    id: randomUUID(),
    email: "owner@example.test",
    name: "Dueño de prueba",
    role: "owner",
    branchId: branch.id,
  };
}

async function customer(user: SessionUser) {
  const data = customerFormSchema.parse({ name: "Cliente de prueba", phoneE164: "912345678" });
  const result = await createCustomer(test.db, user, data, NOW);
  if (!result.ok) throw new Error("No se creó el cliente de prueba.");
  return result.customer.id;
}

async function create(changes: Record<string, unknown> = {}) {
  const result = await createBike(test.db, owner, customerId, { ...input, ...changes }, NOW);
  if (!result.ok) throw new Error(`No se creó la bicicleta: ${result.code}`);
  return result.bike;
}

beforeEach(async () => {
  test = await createTestDb();
  owner = await actor("Vitacura");
  other = await actor("Otra sucursal");
  customerId = await customer(owner);
  otherCustomerId = await customer(other);
  return () => test.close();
});

it("1: guarda marca, modelo, tipo y datos opcionales con el cliente y su sucursal", async () => {
  const data = {
    brand: "Specialized",
    model: "Diverge",
    bikeType: "gravel",
    year: 2024,
    size: "54",
    color: "Negro",
    serialNumber: "SERIE-PRUEBA",
    kmNoted: 1250,
    notes: "Revisar frenos",
  };
  const bike = await create(data);
  expect(bike).toMatchObject({
    ...data,
    branchId: owner.branchId,
    customerId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(await getBike(test.db, owner, bike.id)).toEqual(bike);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("2: rechaza un tipo inválido como error de validación sin insertar", async () => {
  const invalid = { ...input, bikeType: "bmx" };
  const parsed = bikeFormSchema.safeParse(invalid);
  expect(parsed.success).toBe(false);
  if (!parsed.success)
    expect(parsed.error.issues[0]?.message).toBe("Selecciona un tipo de bicicleta válido.");
  expect(await createBike(test.db, owner, customerId, invalid, NOW)).toEqual({
    ok: false,
    code: "validation_error",
  });
  expect(await test.db.select().from(bikes)).toEqual([]);
});

it("3: devuelve las dos bicicletas del cliente", async () => {
  const first = await create();
  const second = await create({ model: "Domane", bikeType: "ruta" });
  const unrelated = await createBike(test.db, other, otherCustomerId, input, NOW);
  expect(unrelated.ok).toBe(true);
  const listed = await listBikesOfCustomer(test.db, owner, customerId);
  expect(listed).toHaveLength(2);
  expect(listed.map((bike) => bike.id).sort()).toEqual([first.id, second.id].sort());
  expect(await listBikesOfCustomer(test.db, other, customerId)).toEqual([]);
  expect(await listBikesOfCustomer(test.db, owner, otherCustomerId)).toEqual([]);
});

it("4: rechaza kilometraje negativo sin cambiar ningún campo de la fila", async () => {
  const bike = await create({ kmNoted: 100 });
  const invalid = { ...input, brand: "Otra marca", kmNoted: -1 };
  expect(bikeFormSchema.safeParse(invalid).success).toBe(false);
  expect(await updateBike(test.db, owner, bike.id, invalid, LATER)).toEqual({
    ok: false,
    code: "validation_error",
  });
  expect(await getBike(test.db, owner, bike.id)).toEqual(bike);
  expect(await createBike(test.db, owner, customerId, invalid, NOW)).toEqual({
    ok: false,
    code: "validation_error",
  });
  expect(await test.db.select().from(bikes)).toHaveLength(1);
});

it("insertBike rechaza un cliente de otra sucursal sin insertar", async () => {
  expect(await insertBike(test.db, owner.branchId, otherCustomerId, input, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await test.db.select().from(bikes)).toEqual([]);
});

it("rechaza clientes inexistentes y createBike también impide cruzar sucursales", async () => {
  for (const id of [randomUUID(), otherCustomerId]) {
    expect(await createBike(test.db, owner, id, input, NOW)).toEqual({
      ok: false,
      code: "not_found",
    });
  }
  expect(await test.db.select().from(bikes)).toEqual([]);
});

it("permite insertBike sin permiso de gestión y protege createBike y updateBike", async () => {
  const mechanic: SessionUser = { ...owner, role: "mechanic" };
  expect(await createBike(test.db, mechanic, customerId, input, NOW)).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await test.db.select().from(bikes)).toEqual([]);
  const result = await insertBike(test.db, mechanic.branchId, customerId, input, NOW);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Falta la bicicleta de prueba.");
  expect(
    await updateBike(test.db, mechanic, result.bike.id, { ...input, model: "Otro" }, LATER),
  ).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(await getBike(test.db, owner, result.bike.id)).toEqual(result.bike);
});

it("edita con la fecha inyectada y no lee ni modifica bicicletas de otra sucursal", async () => {
  const bike = await create();
  expect(await getBike(test.db, other, bike.id)).toBeNull();
  expect(await getBike(test.db, owner, randomUUID())).toBeNull();
  expect(await updateBike(test.db, other, bike.id, { ...input, model: "Otro" }, LATER)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await getBike(test.db, owner, bike.id)).toEqual(bike);
  const result = await updateBike(
    test.db,
    owner,
    bike.id,
    { ...input, model: "Domane", kmNoted: "0" },
    LATER,
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.bike).toMatchObject({
      model: "Domane",
      kmNoted: 0,
      createdAt: NOW,
      updatedAt: LATER,
    });
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("valida los límites y convierte campos opcionales vacíos a null", () => {
  for (const changes of [
    { brand: "" },
    { brand: "x".repeat(61) },
    { model: "" },
    { model: "x".repeat(81) },
    { year: 1979 },
    { year: 2101 },
    { year: "2024.5" },
    { year: "abc" },
    { size: "x".repeat(21) },
    { color: "x".repeat(41) },
    { serialNumber: "x".repeat(81) },
    { kmNoted: 0.5 },
    { kmNoted: true },
    { kmNoted: 2147483648 },
    { notes: "x".repeat(1001) },
  ]) {
    const parsed = bikeFormSchema.safeParse({ ...input, ...changes });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/Ingresa|superar/);
  }
  expect(
    bikeFormSchema.parse({
      ...input,
      year: " ",
      size: "",
      color: " ",
      serialNumber: "",
      kmNoted: "",
      notes: "",
    }),
  ).toEqual(input);
  for (const bikeType of BIKE_TYPES) {
    expect(bikeFormSchema.safeParse({ ...input, bikeType }).success).toBe(true);
  }
  expect(bikeFormSchema.parse({ ...input, year: "1980", kmNoted: "0" })).toMatchObject({
    year: 1980,
    kmNoted: 0,
  });
  expect(bikeFormSchema.safeParse({ ...input, year: 2100 }).success).toBe(true);
});

it("la base garantiza tipo, año y kilometraje incluso con inserciones directas", async () => {
  for (const changes of [{ bikeType: "bmx" }, { year: 1979 }, { year: 2101 }, { kmNoted: -1 }]) {
    await expect(
      test.db.insert(bikes).values({
        ...input,
        ...changes,
        branchId: owner.branchId,
        customerId,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  }
  expect(await test.db.select().from(bikes)).toEqual([]);
});
