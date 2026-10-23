import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { customers } from "../../src/server/db/schema-taller.ts";
import { branches } from "../../src/server/db/schema.ts";
import { searchTaller } from "../../src/server/taller/search.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

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

async function seed(name: string, changes: Partial<typeof customers.$inferInsert> = {}) {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name, phoneE164: "+56911112222", ...changes })
    .returning({
      id: customers.id,
      name: customers.name,
      phoneE164: customers.phoneE164,
      rut: customers.rut,
    });
  if (!customer) throw new Error("Falta el cliente de prueba");
  return customer;
}

beforeEach(async () => {
  test = await createTestDb();
  owner = await actor("Vitacura");
  other = await actor("Otra sucursal");
  return () => test.close();
});

it("1: busca parte del nombre sin distinguir mayúsculas y solo en la sucursal", async () => {
  const customer = await seed("María GONZÁLEZ");
  await seed("Otro cliente");
  await seed("María GONZÁLEZ", { branchId: other.branchId });
  expect(await searchTaller(test.db, owner, "gonzález")).toEqual({
    customers: [customer],
    orders: [],
  });
});

it.each(["9 1111 2222", "+56911112222"])(
  "2: busca el teléfono normalizado %s por coincidencia exacta",
  async (q) => {
    const customer = await seed("Cliente por teléfono");
    await seed(`Nombre ${q}`, { phoneE164: "+56933334444" });
    expect((await searchTaller(test.db, owner, q)).customers).toEqual([customer]);
  },
);

it.each(["12.345.678-5", "12345678-5", "123456785"])(
  "3: busca el RUT normalizado %s por coincidencia exacta",
  async (q) => {
    const customer = await seed("Cliente por RUT", { rut: "12345678-5" });
    await seed(`Nombre ${q}`);
    expect((await searchTaller(test.db, owner, q)).customers).toEqual([customer]);
  },
);

it.each(["%", "_", "\\"])("4: trata %s como texto literal, sin comodines", async (q) => {
  const customer = await seed(`Cliente ${q} literal`);
  await seed("Cliente sin símbolos");
  expect((await searchTaller(test.db, owner, q)).customers).toEqual([customer]);
});

it.each(["cliente", "9 1111 2222", "12.345.678-5"])(
  "5: no devuelve clientes de otra sucursal al buscar %s",
  async (q) => {
    await seed("Cliente de Vitacura", { rut: "12345678-5" });
    expect(await searchTaller(test.db, other, q)).toEqual({ customers: [], orders: [] });
  },
);

it("el mecánico recibe clientes para poder realizar la recepción", async () => {
  const customer = await seed("Cliente para recepción");
  const mechanic = { ...owner, role: "mechanic" } as const;
  expect((await searchTaller(test.db, mechanic, "recepción")).customers).toEqual([customer]);
});

it("recorta la consulta y admite los límites de 1 y 80 caracteres", async () => {
  const name = "a".repeat(80);
  const customer = await seed(name);
  for (const q of [" a ", ` ${name} `]) {
    expect((await searchTaller(test.db, owner, q)).customers).toEqual([customer]);
  }
  for (const q of ["", "   ", "a".repeat(81)]) {
    expect(await searchTaller(test.db, owner, q)).toEqual({ customers: [], orders: [] });
  }
});

it("devuelve un máximo de 20 clientes ordenados por nombre", async () => {
  const names = Array.from({ length: 21 }, (_, i) => `Cliente ${String(i).padStart(2, "0")}`);
  for (const name of [...names].reverse()) await seed(name);
  const result = await searchTaller(test.db, owner, "cliente");
  expect(result.customers.map((customer) => customer.name)).toEqual(names.slice(0, 20));
});

it("parametriza texto con comillas y sintaxis SQL sin ampliar la búsqueda", async () => {
  const q = "' OR 1=1 --";
  const customer = await seed(`Cliente ${q}`);
  await seed("Otro cliente");
  expect((await searchTaller(test.db, owner, q)).customers).toEqual([customer]);
});
