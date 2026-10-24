import { randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { asc, eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { Role } from "../../src/server/auth/permissions.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { auditLog, servicePrices, services } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  createService,
  getService,
  listCatalog,
  priceFor,
  priceFormSchema,
  serviceFormSchema,
  setServicePrice,
  updateService,
} from "../../src/server/taller/catalog.ts";
import {
  BIKE_TYPES,
  MANUAL_TRANSITIONS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
} from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({ db: null as AppDb | null, actor: null as SessionUser | null }));
vi.mock("../../src/server/db/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/db/client.ts")>()),
  getDb: () => {
    if (!holder.db) throw new Error("Base de prueba no inicializada");
    return holder.db;
  },
}));
vi.mock("../../src/server/auth/admin-auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/auth/admin-auth.ts")>()),
  requireAdmin: async () => holder.actor,
}));
const { default: CatalogPage } = await import("../../src/pages/taller/catalogo/index.astro");
const { default: ServicePage } = await import("../../src/pages/taller/catalogo/[id].astro");
const NOW = new Date("2026-10-05T15:00:00.000Z");
const LATER = new Date("2026-10-05T15:01:00.000Z");
const SITE = "https://vectorbikes.cl";
const input = serviceFormSchema.parse({
  name: "Mantención general",
  description: "Descripción privada del cliente",
  estimatedMinutes: 90,
  usualMaterials: "Materiales privados del cliente",
  aftercare: "Recomendación privada del cliente",
});
let test: TestDb;
let owner: SessionUser;

async function seedUser(branchId: string, role: Role): Promise<SessionUser> {
  const [row] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: `Usuario ${role}`,
      email: `${randomUUID()}@ejemplo.cl`,
      passwordHash: "hash-de-prueba",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  if (!row) throw new Error("Falta el usuario");
  return { id: row.id, branchId, role, name: row.name, email: row.email };
}

async function create(actor = owner) {
  const result = await createService(test.db, actor, input, NOW);
  if (!result.ok) throw new Error(`No se creó el servicio: ${result.code}`);
  return result.serviceId;
}

function setPrice(
  serviceId: string,
  priceClp: number,
  bikeType: (typeof BIKE_TYPES)[number] = "mtb",
  actor = owner,
) {
  return setServicePrice(test.db, actor, { serviceId, bikeType, priceClp }, LATER);
}

async function render(id?: string, data?: Record<string, string>, origin = SITE) {
  const path = `/taller/catalogo${id ? `/${id}` : ""}`;
  const request = new Request(`${SITE}${path}`, {
    method: data ? "POST" : "GET",
    headers: data ? { origin, "content-type": "application/x-www-form-urlencoded" } : {},
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(id ? ServicePage : CatalogPage, {
    request,
    params: id ? { id } : {},
  });
}

beforeEach(async () => {
  test = await createTestDb();
  holder.db = test.db;
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal");
  owner = await seedUser(branch.id, "owner");
  holder.actor = owner;
  return async () => {
    holder.actor = null;
    holder.db = null;
    await test.close();
  };
});

it.each(["owner", "admin"] as const)(
  "1: %s crea el servicio completo en su sucursal",
  async (role) => {
    const actor = role === "owner" ? owner : await seedUser(owner.branchId, role);
    const id = await create(actor);
    const [service] = await test.db.select().from(services).where(eq(services.id, id));
    expect(service).toMatchObject({
      ...input,
      branchId: actor.branchId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  },
);

it("2: mantiene una fila por servicio y tipo, con upsert para los cinco tipos", async () => {
  const id = await create();
  for (const type of BIKE_TYPES) {
    expect(await setPrice(id, 10000, type)).toEqual({ ok: true, serviceId: id });
    expect(await setPrice(id, 20000, type)).toEqual({ ok: true, serviceId: id });
  }
  const rows = await test.db.select().from(servicePrices);
  expect(rows).toHaveLength(5);
  expect(rows.every((row) => row.priceClp === 20000 && row.branchId === owner.branchId)).toBe(true);
  expect(new Set(rows.map((row) => row.bikeType))).toEqual(new Set(BIKE_TYPES));
});

it("3: el mecánico recibe forbidden y los precios quedan iguales fila por fila", async () => {
  const id = await create();
  await setPrice(id, 12000);
  const actor = await seedUser(owner.branchId, "mechanic");
  const before = await test.db.select().from(servicePrices).orderBy(asc(servicePrices.id));
  const auditBefore = await test.db.select().from(auditLog);
  expect(await setPrice(id, 99000, "mtb", actor)).toEqual({ ok: false, code: "forbidden" });
  expect(await setPrice(id, 99000, "ruta", actor)).toEqual({ ok: false, code: "forbidden" });
  expect(await test.db.select().from(servicePrices).orderBy(asc(servicePrices.id))).toEqual(before);
  expect(await test.db.select().from(auditLog)).toEqual(auditBefore);
});

it("4: audita el autor, instante y precio anterior/nuevo en la misma transacción", async () => {
  const id = await create();
  await setServicePrice(test.db, owner, { serviceId: id, bikeType: "mtb", priceClp: 15000 }, NOW);
  await setPrice(id, 25000);
  const rows = await test.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "catalog.price_changed"))
    .orderBy(asc(auditLog.createdAt));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    actorUserId: owner.id,
    createdAt: NOW,
    details: { serviceId: id, bikeType: "mtb", before: null, after: 15000 },
  });
  expect(rows[1]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: owner.id,
    entity: "services",
    entityId: id,
    createdAt: LATER,
    details: { serviceId: id, bikeType: "mtb", before: 15000, after: 25000 },
  });
  const before = await test.db.select().from(servicePrices);
  await expect(setPrice(id, 35000, "mtb", { ...owner, id: randomUUID() })).rejects.toThrow();
  expect(await test.db.select().from(servicePrices)).toEqual(before);
  expect(await test.db.select().from(auditLog)).toHaveLength(3);
});

it("audita creación y edición solo con ID y nombres de campos, sin texto libre", async () => {
  const id = await create();
  const changed = serviceFormSchema.parse({
    ...input,
    name: "Mantención completa",
    description: "Descripción nueva privada",
    usualMaterials: "Materiales nuevos privados",
    aftercare: "Cuidados nuevos privados",
    isActive: false,
  });
  expect(await updateService(test.db, owner, id, changed, LATER)).toEqual({
    ok: true,
    serviceId: id,
  });
  const rows = await test.db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
  expect(rows.map((row) => row.details)).toEqual([
    {
      serviceId: id,
      fields: [
        "name",
        "description",
        "estimatedMinutes",
        "usualMaterials",
        "aftercare",
        "isActive",
      ],
    },
    { serviceId: id, fields: ["name", "description", "usualMaterials", "aftercare", "isActive"] },
  ]);
  for (const row of rows) {
    for (const text of [
      input.name,
      input.description,
      input.usualMaterials,
      input.aftercare,
      changed.name,
      changed.description,
      changed.usualMaterials,
      changed.aftercare,
    ]) {
      expect(JSON.stringify(row.details)).not.toContain(text);
    }
  }
  expect(await getService(test.db, owner, id)).toMatchObject(changed);
});

it("priceFor devuelve null para un servicio de otra sucursal y conserva el precio cero", async () => {
  const id = await create();
  await setPrice(id, 0);
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la otra sucursal");
  const other = await seedUser(branch.id, "owner");
  expect(await priceFor(test.db, owner, id, "mtb")).toBe(0);
  expect(await priceFor(test.db, owner, id, "ruta")).toBeNull();
  expect(await priceFor(test.db, other, id, "mtb")).toBeNull();
  expect(await getService(test.db, other, id)).toBeNull();
  expect(await listCatalog(test.db, other)).toEqual([]);
  const before = await test.db.select().from(servicePrices);
  expect(await setPrice(id, 500, "mtb", other)).toEqual({ ok: false, code: "not_found" });
  expect(await updateService(test.db, other, id, input, LATER)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await test.db.select().from(servicePrices)).toEqual(before);
});

it("rechaza nombres duplicados sin auditar y revierte una creación si falla su auditoría", async () => {
  await create();
  expect(await createService(test.db, owner, input, NOW)).toEqual({
    ok: false,
    code: "name_taken",
  });
  await expect(
    createService(
      test.db,
      { ...owner, id: randomUUID() },
      { ...input, name: "Otro servicio" },
      NOW,
    ),
  ).rejects.toThrow();
  expect(await test.db.select().from(services)).toHaveLength(1);
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it("rechaza todos los cambios de catálogo para recepción y mecánico", async () => {
  const id = await create();
  const before = await test.db.select().from(services);
  for (const role of ["reception", "mechanic"] as const) {
    const actor = await seedUser(owner.branchId, role);
    expect(await createService(test.db, actor, input, NOW)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await updateService(test.db, actor, id, input, NOW)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await setPrice(id, 500, "mtb", actor)).toEqual({ ok: false, code: "forbidden" });
  }
  expect(await test.db.select().from(services)).toEqual(before);
  expect(await test.db.select().from(servicePrices)).toEqual([]);
});

it("valida longitudes, duración, tipo y precios enteros sin aceptar campos vacíos", () => {
  for (const changes of [
    { name: "X" },
    { name: "X".repeat(81) },
    { description: "x".repeat(1001) },
    { usualMaterials: "x".repeat(1001) },
    { aftercare: "x".repeat(1001) },
    { estimatedMinutes: 4 },
    { estimatedMinutes: 1441 },
    { estimatedMinutes: 5.5 },
  ]) {
    expect(serviceFormSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
  for (const priceClp of ["", -1, 0.5, 2147483648]) {
    expect(
      priceFormSchema.safeParse({ serviceId: randomUUID(), bikeType: "mtb", priceClp }).success,
    ).toBe(false);
  }
  expect(
    priceFormSchema.safeParse({ serviceId: randomUUID(), bikeType: "otro", priceClp: 0 }).success,
  ).toBe(false);
});

it("conserva todas las transiciones y excluye exactamente los saltos propios de flujos", () => {
  const transitions: Record<string, readonly string[]> = ORDER_TRANSITIONS;
  for (const from of ORDER_STATUSES) {
    const expected = transitions[from]?.filter(
      (to) =>
        to !== "esperando_aprobacion" &&
        !(from === "reservada" && to === "recibida") &&
        !(from === "esperando_aprobacion" && to === "en_reparacion") &&
        !(from === "control_calidad" && to === "lista_para_retirar") &&
        !(from === "lista_para_retirar" && to === "entregada"),
    );
    expect(MANUAL_TRANSITIONS[from]).toEqual(expected);
  }
});

it("redirige sin sesión y permite lectura al mecánico, pero rechaza cualquier POST con 403", async () => {
  const id = await create();
  holder.actor = null;
  for (const route of [undefined, id]) {
    const response = await render(route);
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  holder.actor = await seedUser(owner.branchId, "mechanic");
  for (const route of [undefined, id]) {
    const response = await render(route);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).not.toContain("Crear servicio");
    expect(html).not.toContain("Guardar precio");
    expect((await render(route, { accion: "precio", priceClp: "99000" })).status).toBe(403);
  }
  expect(await test.db.select().from(servicePrices)).toEqual([]);
});

it("verifica Origin antes de zod y enlaza errores de validación en español", async () => {
  const id = await create();
  for (const route of [undefined, id]) {
    expect((await render(route, {}, "https://otro.cl")).status).toBe(403);
  }
  const invalid = await render(id, { accion: "precio", bikeType: "mtb", priceClp: "-1" });
  expect(invalid.status).toBe(422);
  const html = await invalid.text();
  expect(html).toContain("Ingresa un precio en pesos chilenos");
  expect(html).toContain('aria-describedby="price-error-mtb"');
  expect(await test.db.select().from(servicePrices)).toEqual([]);
});

it("crea, edita y fija precios por POST con redirección 303 y no-store", async () => {
  const raw = {
    name: "Servicio nuevo",
    description: "Descripción",
    estimatedMinutes: "60",
    usualMaterials: "Materiales",
    aftercare: "Cuidados",
  };
  const created = await render(undefined, raw);
  expect(created.status).toBe(303);
  expect(created.headers.get("location")).toBe("/taller/catalogo?hecho=crear");
  const [service] = await test.db.select().from(services);
  if (!service) throw new Error("Falta el servicio");
  const posts: Record<string, string>[] = [
    { ...raw, accion: "servicio", isActive: "1", name: "Servicio editado" },
    { accion: "precio", bikeType: "mtb", priceClp: "30000" },
  ];
  for (const data of posts) {
    const response = await render(service.id, data);
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(await priceFor(test.db, owner, service.id, "mtb")).toBe(30000);
  expect(await getService(test.db, owner, service.id)).toMatchObject({ name: "Servicio editado" });
});
