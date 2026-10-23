import { randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { Role } from "../../src/server/auth/permissions.ts";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { type Booking, bookings, branches, users } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

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
const { default: ReschedulePage } = await import(
  "../../src/pages/taller/reservas/[id]/reprogramar.astro"
);
const { default: BookingsPage } = await import("../../src/pages/taller/reservas/index.astro");

const SITE = "https://vectorbikes.cl";
/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const MANANA = "2026-09-16";
const PASADO = "2026-09-17";

let test: TestDb;
let db: AppDb;
let owner: SessionUser;

function input(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    mode: "taller",
    serviceDate: MANANA,
    start: "16:30",
    customerName: "Patricia Cruzat",
    phoneE164: "+56911111111",
    email: null,
    bike: "Urbana Oxford",
    description: "Mantención general",
    comuna: null,
    address: null,
    ipHash: null,
    ...overrides,
  };
}

async function crear(overrides: Partial<CreateBookingInput> = {}): Promise<Booking> {
  const result = await createBooking(db, input(overrides), NOW);
  if (!result.ok) throw new Error(`no se creó la reserva: ${result.code}`);
  return result.booking;
}

async function seedUser(role: Role): Promise<SessionUser> {
  const [branch] = await db.select().from(branches);
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const [user] = await db
    .insert(users)
    .values({
      branchId: branch.id,
      role,
      name: `Usuario ${role}`,
      email: `${randomUUID()}@ejemplo.cl`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId: branch.id, role, name: user.name, email: user.email };
}

async function render(id: string, data?: Record<string, string>, search = "") {
  const url = `${SITE}/taller/reservas/${id}/reprogramar${search}`;
  const request = new Request(url, {
    method: data ? "POST" : "GET",
    headers: data ? { origin: SITE, "content-type": "application/x-www-form-urlencoded" } : {},
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(ReschedulePage, { request, params: { id } });
}

async function renderBookings(search = "") {
  const request = new Request(`${SITE}/taller/reservas${search}`);
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(BookingsPage, { request });
}

beforeEach(async () => {
  consoleOutbox.length = 0;
  // Las páginas toman la hora al renderizar con `new Date()`, así que sin fijar el reloj las fechas
  // de la prueba quedarían en el pasado. Solo se finge `Date`: los temporizadores reales siguen
  // vivos para PGlite.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  test = await createTestDb();
  db = test.db;
  holder.db = db;
  await db.insert(branches).values({ name: "Vitacura" });
  owner = await seedUser("owner");
  holder.actor = owner;
  return async () => {
    holder.actor = null;
    holder.db = null;
    vi.useRealTimers();
    await test.close();
  };
});

it("muestra la reserva actual y los bloques libres del día elegido", async () => {
  const booking = await crear();

  const html = await (await render(booking.id, undefined, `?service_date=${PASADO}`)).text();

  expect(html).toContain(booking.code);
  expect(html).toContain("Patricia Cruzat");
  expect(html).toContain("Urbana Oxford");
  expect(html).toContain("16:30");
  expect(html).toContain('value="15:00"');
  expect(html).toContain("Reprogramar reserva");
});

it("reprograma y vuelve a la lista con el aviso de la fecha nueva", async () => {
  const booking = await crear();

  const response = await render(booking.id, { service_date: PASADO, start: "15:30" });

  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toContain("/taller/reservas?");
  expect(location).toContain("hecho=reprogramada");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
  expect(stored?.serviceDate).toBe(PASADO);

  const aviso = await (await renderBookings(new URL(location, SITE).search)).text();
  expect(aviso).toContain("Reserva reprogramada");
  expect(aviso).toContain("17 de septiembre");
  expect(aviso).toContain("15:30");
});

it("un bloque ya tomado responde 422, explica y conserva el día elegido", async () => {
  const booking = await crear();
  await crear({ serviceDate: PASADO, start: "15:30", phoneE164: "+56922222222" });

  const response = await render(booking.id, { service_date: PASADO, start: "15:30" });

  expect(response.status).toBe(422);
  const html = await response.text();
  expect(html).toContain("El bloque ya no está disponible");
  expect(html).toContain(PASADO);
  const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
  expect(stored?.serviceDate).toBe(MANANA);
});

it("una reserva con orden de trabajo ya no se reprograma", async () => {
  const booking = await crear();
  const [customer] = await db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Patricia Cruzat", phoneE164: "+56911111111" })
    .returning();
  const [bike] = await db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer?.id ?? "",
      brand: "Oxford",
      model: "Urbana",
      bikeType: "urbana",
    })
    .returning();
  await db.insert(workOrders).values({
    branchId: owner.branchId,
    number: 1,
    customerId: customer?.id ?? "",
    bikeId: bike?.id ?? "",
    bookingId: booking.id,
    requestedService: "Mantención general",
    createdBy: owner.id,
  });

  const response = await render(booking.id, { service_date: PASADO, start: "15:30" });

  expect(response.status).toBe(409);
  expect(await response.text()).toContain("ya no se puede reprogramar");
});

it("el mecánico no entra a la pantalla", async () => {
  const booking = await crear();
  holder.actor = await seedUser("mechanic");

  expect((await render(booking.id)).status).toBe(403);
});

it("la lista ofrece reprogramar solo donde todavía se puede", async () => {
  const booking = await crear();

  const html = await (await renderBookings()).text();

  expect(html).toContain(`/taller/reservas/${booking.id}/reprogramar`);
  expect(html).toContain("Reprogramar");
});
