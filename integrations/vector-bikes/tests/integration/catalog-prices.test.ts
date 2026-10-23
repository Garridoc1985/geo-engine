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
  pricesFormSchema,
  serviceFormSchema,
  setServicePrices,
} from "../../src/server/taller/catalog.ts";
import { BIKE_TYPES } from "../../src/server/taller/rules.ts";
import type { BikeType } from "../../src/server/taller/rules.ts";
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
const { default: ServicePage } = await import("../../src/pages/taller/catalogo/[id].astro");

const NOW = new Date("2026-10-05T15:00:00.000Z");
const LATER = new Date("2026-10-05T15:01:00.000Z");
const SITE = "https://vectorbikes.cl";
const BASE = serviceFormSchema.parse({ name: "Mantención general", estimatedMinutes: 90 });

let test: TestDb;
let owner: SessionUser;

type Prices = Record<BikeType, number | null>;
const NONE: Prices = { mtb: null, ruta: null, gravel: null, urbana: null, ebike: null };

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

async function create(actor = owner, name = "Mantención general") {
  const result = await createService(test.db, actor, { ...BASE, name }, NOW);
  if (!result.ok) throw new Error(`No se creó el servicio: ${result.code}`);
  return result.serviceId;
}

function save(serviceId: string, prices: Partial<Prices>, actor = owner) {
  return setServicePrices(test.db, actor, { serviceId, prices: { ...NONE, ...prices } }, LATER);
}

async function savedPrices(serviceId: string) {
  const rows = await test.db
    .select()
    .from(servicePrices)
    .where(eq(servicePrices.serviceId, serviceId))
    .orderBy(asc(servicePrices.bikeType));
  return Object.fromEntries(rows.map((row) => [row.bikeType, row.priceClp]));
}

async function priceAudits(serviceId: string) {
  return test.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, serviceId))
    .orderBy(asc(auditLog.createdAt));
}

async function render(id: string, data?: Record<string, string>, origin = SITE) {
  const request = new Request(`${SITE}/taller/catalogo/${id}`, {
    method: data ? "POST" : "GET",
    headers: data ? { origin, "content-type": "application/x-www-form-urlencoded" } : {},
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(ServicePage, { request, params: { id } });
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

it("guarda varios precios en una sola llamada y deja sin precio los vacíos", async () => {
  const id = await create();

  expect(await save(id, { mtb: 33283, ruta: 40000 })).toEqual({ ok: true, serviceId: id });
  expect(await savedPrices(id)).toEqual({ mtb: 33283, ruta: 40000 });
});

it("vaciar un precio existente lo quita", async () => {
  const id = await create();
  await save(id, { mtb: 33283, gravel: 50000 });

  expect(await save(id, { mtb: 33283 })).toEqual({ ok: true, serviceId: id });
  expect(await savedPrices(id)).toEqual({ mtb: 33283 });
  expect((await getService(test.db, owner, id))?.prices).toEqual({ mtb: 33283 });
});

it("audita solo los tipos que cambiaron, con before y after", async () => {
  const id = await create();
  await save(id, { mtb: 10000, ruta: 20000 });
  const before = (await priceAudits(id)).length;

  await save(id, { mtb: 10000, ruta: 25000 });

  const audits = (await priceAudits(id)).slice(before);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.action).toBe("catalog.price_changed");
  expect(audits[0]?.details).toMatchObject({ bikeType: "ruta", before: 20000, after: 25000 });
});

it("quitar un precio se audita con after en null", async () => {
  const id = await create();
  await save(id, { mtb: 10000 });
  const before = (await priceAudits(id)).length;

  await save(id, {});

  const audits = (await priceAudits(id)).slice(before);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.details).toMatchObject({ bikeType: "mtb", before: 10000, after: null });
});

it("sin cambios no escribe auditoría", async () => {
  const id = await create();
  await save(id, { mtb: 10000 });
  const before = (await priceAudits(id)).length;

  expect(await save(id, { mtb: 10000 })).toEqual({ ok: true, serviceId: id });
  expect(await priceAudits(id)).toHaveLength(before);
});

it("recepción y mecánico no pueden fijar precios", async () => {
  const id = await create();
  for (const role of ["reception", "mechanic"] as const) {
    const actor = await seedUser(owner.branchId, role);
    expect(await save(id, { mtb: 1000 }, actor)).toEqual({ ok: false, code: "forbidden" });
  }
  expect(await savedPrices(id)).toEqual({});
});

it("un servicio de otra sucursal no se encuentra", async () => {
  const id = await create();
  const [other] = await test.db.insert(branches).values({ name: "Las Condes" }).returning();
  if (!other) throw new Error("Falta la sucursal");
  const stranger = await seedUser(other.id, "owner");

  expect(await save(id, { mtb: 1000 }, stranger)).toEqual({ ok: false, code: "not_found" });
  expect(await savedPrices(id)).toEqual({});
});

it("normaliza los montos como los escribe la gente", () => {
  const parsed = pricesFormSchema.parse({
    serviceId: "11111111-1111-4111-8111-111111111111",
    prices: { mtb: "33283", ruta: "33.283", gravel: "$33.283", urbana: " $ 33.283 ", ebike: "" },
  });

  expect(parsed.prices).toEqual({
    mtb: 33283,
    ruta: 33283,
    gravel: 33283,
    urbana: 33283,
    ebike: null,
  });
});

it("rechaza decimales, negativos y montos fuera de rango", () => {
  for (const bad of ["33,5", "33.5", "-1", "2147483648", "abc"]) {
    const result = pricesFormSchema.safeParse({
      serviceId: "11111111-1111-4111-8111-111111111111",
      prices: { ...NONE, mtb: bad },
    });
    expect(result.success, `"${bad}" debería ser inválido`).toBe(false);
  }
});

it("createService puede crear el servicio y sus precios juntos", async () => {
  const result = await createService(
    test.db,
    owner,
    { ...BASE, name: "Relleno de líquido antipinchazo" },
    NOW,
    { mtb: 15000, gravel: 18000, ruta: null, urbana: null, ebike: null },
  );
  if (!result.ok) throw new Error(`No se creó: ${result.code}`);

  expect(await savedPrices(result.serviceId)).toEqual({ mtb: 15000, gravel: 18000 });
  expect(await test.db.select().from(services)).toHaveLength(1);
});

it("createService sin precios deja el servicio sin precios", async () => {
  const id = await create(owner, "Sin precios");

  expect(await savedPrices(id)).toEqual({});
});

it("la ficha guarda los cinco precios con una acción y redirige con el aviso", async () => {
  const id = await create();

  const response = await render(id, {
    accion: "precios",
    precio_mtb: "33.283",
    precio_ruta: "",
    precio_gravel: "$18.000",
    precio_urbana: "",
    precio_ebike: "",
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("hecho=");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await savedPrices(id)).toEqual({ mtb: 33283, gravel: 18000 });
});

it("un precio inválido no guarda ninguno, responde 422 y conserva lo escrito", async () => {
  const id = await create();
  await save(id, { ruta: 40000 });

  const response = await render(id, {
    accion: "precios",
    precio_mtb: "33,5",
    precio_ruta: "99000",
    precio_gravel: "",
    precio_urbana: "",
    precio_ebike: "",
  });

  expect(response.status).toBe(422);
  const html = await response.text();
  expect(html).toContain('aria-describedby="price-error-mtb"');
  expect(html).toContain("33,5");
  expect(html).toContain("99000");
  expect(await savedPrices(id)).toEqual({ ruta: 40000 });
});

it("el formulario de precios no se muestra sin permiso de edición", async () => {
  const id = await create();
  holder.actor = await seedUser(owner.branchId, "mechanic");

  const html = await (await render(id)).text();

  expect(html).not.toContain("Guardar precio");
  expect(html).not.toContain('name="precio_mtb"');
});

it("sin permiso de edición igual se ven los precios vigentes", async () => {
  const id = await create();
  await save(id, { mtb: 33283 });
  holder.actor = await seedUser(owner.branchId, "mechanic");

  const html = await (await render(id)).text();

  expect(html).toContain("Precios por tipo de bicicleta");
  expect(html).toContain("33.283");
  expect(html).toContain("Sin precio");
});

it("la ficha muestra los cinco campos con los precios actuales", async () => {
  const id = await create();
  await save(id, { mtb: 33283 });

  const html = await (await render(id)).text();

  for (const type of BIKE_TYPES) {
    expect(html).toContain(`name="precio_${type}"`);
  }
  expect(html).toContain("Guardar precios");
  expect(html).toContain('value="33283"');
});
