import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import { rescheduleBooking } from "../../src/server/booking/reschedule-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { type Booking, bookings, branches, users } from "../../src/server/db/schema.ts";
import { freeBlocks } from "../../src/server/taller/manual-booking.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local, un martes. El 21 es lunes. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const LUNES = "2026-09-21";

let test: TestDb;
let db: AppDb;
let owner: SessionUser;

function input(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  const retiro = overrides.mode === "retiro";
  return {
    mode: "taller",
    serviceDate: LUNES,
    start: "16:00",
    customerName: "Patricia Cruzat",
    phoneE164: `+5691${String(randomUUID().replace(/\D/g, "").slice(0, 7)).padEnd(7, "0")}`,
    email: null,
    bike: "Urbana Oxford",
    description: "Mantención general",
    comuna: retiro ? "Vitacura" : null,
    address: retiro ? "Av. Las Flores 123" : null,
    ipHash: null,
    ...overrides,
  };
}

async function crear(overrides: Partial<CreateBookingInput> = {}) {
  return createBooking(db, input(overrides), NOW);
}

async function crearOk(overrides: Partial<CreateBookingInput> = {}): Promise<Booking> {
  const result = await crear(overrides);
  if (!result.ok) throw new Error(`no se creó: ${result.code}`);
  return result.booking;
}

beforeEach(async () => {
  test = await createTestDb();
  db = test.db;
  const [branch] = await db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const [user] = await db
    .insert(users)
    .values({
      branchId: branch.id,
      role: "owner",
      name: "Dueña",
      email: `${randomUUID()}@ejemplo.cl`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  owner = { id: user.id, branchId: branch.id, role: "owner", name: user.name, email: user.email };
  return () => test.close();
});

it("un retiro entra a las 09:00 de un lunes y una entrega en el taller no", async () => {
  const retiro = await crearOk({ mode: "retiro", start: "09:00" });

  expect(retiro.serviceDate).toBe(LUNES);
  expect(retiro.startsAt.toISOString()).toBe("2026-09-21T12:00:00.000Z");
  expect(retiro.endsAt.toISOString()).toBe("2026-09-21T13:00:00.000Z");
  expect(await crear({ start: "09:00" })).toEqual({ ok: false, code: "slot_unavailable" });
});

it("una reserva se puede mover a la mañana si es retiro", async () => {
  const retiro = await crearOk({ mode: "retiro", start: "15:00" });

  const result = await rescheduleBooking(
    db,
    owner,
    { bookingId: retiro.id, serviceDate: LUNES, start: "10:00" },
    NOW,
  );

  expect(result).toMatchObject({ ok: true });
  const [stored] = await db.select().from(bookings).where(eq(bookings.id, retiro.id));
  expect(stored?.startsAt.toISOString()).toBe("2026-09-21T13:00:00.000Z");
});

it("el tope de cuatro por día cuenta la mañana y la tarde juntas", async () => {
  await crearOk({ mode: "retiro", start: "09:00" });
  await crearOk({ mode: "retiro", start: "10:00" });
  await crearOk({ start: "15:00" });
  await crearOk({ start: "16:00" });

  expect(await crear({ start: "17:00" })).toEqual({ ok: false, code: "slot_unavailable" });
  expect(await crear({ mode: "retiro", start: "11:00" })).toEqual({
    ok: false,
    code: "slot_unavailable",
  });
});

it("el taller ofrece los bloques de la mañana solo para retiro", async () => {
  const retiro = await freeBlocks(db, LUNES, "retiro", NOW);
  const taller = await freeBlocks(db, LUNES, "taller", NOW);

  expect(retiro.at(0)?.start).toBe("09:00");
  expect(taller.at(0)?.start).toBe("15:00");
});
