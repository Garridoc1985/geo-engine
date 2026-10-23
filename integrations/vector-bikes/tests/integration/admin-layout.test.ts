import { randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { Role } from "../../src/server/auth/permissions.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { type Booking, branches, users } from "../../src/server/db/schema.ts";
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
const { default: AgendaPage } = await import("../../src/pages/admin/index.astro");
const { default: BlocksPage } = await import("../../src/pages/admin/bloqueos.astro");
const { default: BookingPage } = await import("../../src/pages/admin/reservas/[id].astro");
const { default: TallerHome } = await import("../../src/pages/taller/index.astro");

const SITE = "https://vectorbikes.cl";
/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");

let test: TestDb;
let db: AppDb;
let owner: SessionUser;

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

async function crearReserva(): Promise<Booking> {
  const result = await createBooking(
    db,
    {
      mode: "taller",
      serviceDate: "2026-09-16",
      start: "16:30",
      customerName: "Camila Soto",
      phoneE164: "+56911111111",
      email: "camila@ejemplo.cl",
      bike: "Gravel Canyon",
      description: "Mantención general",
      comuna: null,
      address: null,
      ipHash: null,
    },
    NOW,
  );
  if (!result.ok) throw new Error(result.code);
  return result.booking;
}

async function render(page: unknown, path: string, params?: Record<string, string>) {
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  const response = await container.renderToResponse(page as never, {
    request: new Request(`${SITE}${path}`),
    params,
  });
  return response.text();
}

beforeEach(async () => {
  // Las páginas toman la hora al renderizar; sin fijarla, la agenda mira otro día.
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

it("la agenda usa el menú del taller y suelta su barra propia", async () => {
  const html = await render(AgendaPage, "/admin");

  expect(html).toContain("Operación");
  expect(html).toContain("Gestión");
  expect(html).toContain('href="/admin/bloqueos"');
  expect(html).not.toContain('aria-label="Panel"');
  // El contenido no cambia.
  expect(html).toContain("Agenda");
  expect(html).toContain("Ver día");
  expect(html).toContain("Día anterior");
  expect(html).toContain("Día siguiente");
});

it("bloqueos usa el mismo marco y conserva sus formularios", async () => {
  const html = await render(BlocksPage, "/admin/bloqueos");

  expect(html).toContain("Operación");
  expect(html).not.toContain('aria-label="Panel"');
  expect(html).toContain("Bloqueos");
  expect(html).toContain('action="/admin/bloqueos"');
});

it("el detalle de la reserva usa el mismo marco y conserva sus acciones", async () => {
  const booking = await crearReserva();

  const html = await render(BookingPage, `/admin/reservas/${booking.id}`, { id: booking.id });

  expect(html).toContain("Operación");
  expect(html).not.toContain('aria-label="Panel"');
  expect(html).toContain(booking.code);
  expect(html).toContain("Reprogramar");
  expect(html).toContain("Cancelar reserva");
  expect(html).toContain("Marcar no-show");
});

it("el mecánico no ve Agenda ni Bloqueos en el menú", async () => {
  holder.actor = await seedUser("mechanic");

  const html = await render(TallerHome, "/taller");

  expect(html).not.toContain('href="/admin/bloqueos"');
  expect(html).not.toContain('href="/admin"');
});
