import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import { rescheduleBooking } from "../../src/server/booking/reschedule-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import {
  type Booking,
  blockedPeriods,
  bookingBlocks,
  bookings,
  branches,
  users,
} from "../../src/server/db/schema.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local; el 16 es miércoles y el 20, domingo. */
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
    email: "patricia@ejemplo.cl",
    bike: "Urbana Oxford",
    description: "Mantención general",
    comuna: null,
    address: null,
    ipHash: null,
    ...overrides,
  };
}

async function seedUser(role: SessionUser["role"]): Promise<SessionUser> {
  const [branch] = await db.select().from(branches);
  const branchId =
    branch?.id ?? (await db.insert(branches).values({ name: "Vitacura" }).returning())[0]?.id;
  if (!branchId) throw new Error("Falta la sucursal de prueba.");
  const [user] = await db
    .insert(users)
    .values({
      branchId,
      role,
      name: `Usuario ${role}`,
      email: `${randomUUID()}@ejemplo.cl`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function crear(overrides: Partial<CreateBookingInput> = {}): Promise<Booking> {
  const result = await createBooking(db, input(overrides), NOW);
  if (!result.ok) throw new Error(`no se creó la reserva: ${result.code}`);
  return result.booking;
}

/** Bloques activos de una fecha, en orden. */
async function activos(serviceDate: string): Promise<string[]> {
  const rows = await db
    .select({ blockStart: bookingBlocks.blockStart })
    .from(bookingBlocks)
    .where(and(eq(bookingBlocks.serviceDate, serviceDate), eq(bookingBlocks.isActive, true)))
    .orderBy(bookingBlocks.blockStart);
  return rows.map((row) => row.blockStart.slice(0, 5));
}

function mover(booking: Booking, serviceDate: string, start: string, actor = owner, now = NOW) {
  return rescheduleBooking(db, actor, { bookingId: booking.id, serviceDate, start }, now);
}

beforeEach(async () => {
  test = await createTestDb();
  db = test.db;
  await db.insert(branches).values({ name: "Vitacura" });
  owner = await seedUser("owner");
  return () => test.close();
});

describe("rescheduleBooking", () => {
  it("mueve la reserva a otro día, libera el bloque viejo y conserva todo lo demás", async () => {
    const booking = await crear();

    const result = await mover(booking, PASADO, "15:30");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.previous).toEqual({ serviceDate: MANANA, start: "16:30" });
    const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(stored?.serviceDate).toBe(PASADO);
    expect(stored?.code).toBe(booking.code);
    expect(stored?.cancelTokenHash).toBe(booking.cancelTokenHash);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.phoneE164).toBe(booking.phoneE164);
    expect(stored?.reminderSentAt).toBeNull();
    expect(stored?.startsAt.toISOString()).toBe("2026-09-17T18:30:00.000Z");
    expect(stored?.endsAt.toISOString()).toBe("2026-09-17T19:00:00.000Z");
    expect(await activos(MANANA)).toEqual([]);
    expect(await activos(PASADO)).toEqual(["15:30"]);
    expect(await db.select().from(bookings)).toHaveLength(1);
  });

  it("el bloque que libera queda disponible para otro cliente", async () => {
    const booking = await crear();
    await mover(booking, PASADO, "15:30");

    const otra = await createBooking(db, input({ phoneE164: "+56922222222", email: null }), NOW);

    expect(otra.ok).toBe(true);
    expect(await activos(MANANA)).toEqual(["16:30"]);
  });

  it("dentro del mismo día no choca consigo misma, ni siquiera con el día lleno", async () => {
    const booking = await crear();
    for (const [index, start] of ["15:00", "15:30", "16:00"].entries()) {
      await crear({ start, phoneE164: `+5693000000${index}`, email: null });
    }

    expect(await mover(booking, MANANA, "17:00")).toMatchObject({ ok: true });
    expect(await activos(MANANA)).toEqual(["15:00", "15:30", "16:00", "17:00"]);
  });

  it("un retiro mueve sus dos bloques y libera los dos viejos", async () => {
    const booking = await crear({
      mode: "retiro",
      start: "15:00",
      comuna: "Vitacura",
      address: "Av. Kennedy 7666",
    });
    expect(await activos(MANANA)).toEqual(["15:00", "15:30"]);

    expect(await mover(booking, PASADO, "17:00")).toMatchObject({ ok: true });

    expect(await activos(MANANA)).toEqual([]);
    expect(await activos(PASADO)).toEqual(["17:00", "17:30"]);
  });

  it("un retiro no se mueve si el segundo bloque está tomado", async () => {
    const booking = await crear({
      mode: "retiro",
      start: "15:00",
      comuna: "Vitacura",
      address: "Av. Kennedy 7666",
    });
    await crear({ serviceDate: PASADO, start: "17:30", phoneE164: "+56922222222", email: null });

    expect(await mover(booking, PASADO, "17:00")).toEqual({ ok: false, code: "slot_unavailable" });
    expect(await activos(MANANA)).toEqual(["15:00", "15:30"]);
  });

  it("rechaza el bloque tomado, el domingo, el feriado, el bloqueo y lo fuera de plazo", async () => {
    const booking = await crear();
    await crear({ serviceDate: PASADO, start: "15:00", phoneE164: "+56922222222", email: null });
    await db.insert(blockedPeriods).values({
      serviceDate: "2026-09-21",
      startTime: null,
      endTime: null,
      reason: "Mantención del taller",
    });

    const casos: Array<[string, string]> = [
      [PASADO, "15:00"], // bloque tomado
      ["2026-09-20", "16:00"], // domingo
      ["2026-09-18", "16:00"], // feriado: Independencia Nacional
      ["2026-09-21", "16:00"], // día bloqueado
      ["2026-10-20", "16:00"], // más allá del horizonte de 30 días
    ];
    for (const [serviceDate, start] of casos) {
      expect(await mover(booking, serviceDate, start), `${serviceDate} ${start}`).toEqual({
        ok: false,
        code: "slot_unavailable",
      });
    }
    expect(await activos(MANANA)).toEqual(["16:30"]);
  });

  it("respeta la antelación de 120 minutos", async () => {
    const booking = await crear();
    // 2026-09-16 14:30 hora local: faltan 30 minutos para el bloque de las 15:00.
    const enLaVispera = new Date("2026-09-16T17:30:00.000Z");

    expect(await mover(booking, MANANA, "15:00", owner, enLaVispera)).toEqual({
      ok: false,
      code: "slot_unavailable",
    });
    expect(await mover(booking, MANANA, "17:30", owner, enLaVispera)).toMatchObject({ ok: true });
  });

  it("no reprograma una reserva que ya no está confirmada ni una con orden de trabajo", async () => {
    for (const status of ["cancelled", "completed", "no_show", "ready_for_pickup"] as const) {
      const booking = await crear({ start: "15:30", phoneE164: `+5694${status.length}0000000` });
      await db.update(bookings).set({ status }).where(eq(bookings.id, booking.id));
      expect(await mover(booking, PASADO, "16:00"), status).toEqual({
        ok: false,
        code: "not_reschedulable",
      });
      await db.delete(bookingBlocks).where(eq(bookingBlocks.bookingId, booking.id));
      await db.delete(bookings).where(eq(bookings.id, booking.id));
    }

    const conOrden = await crear();
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
      bookingId: conOrden.id,
      requestedService: "Mantención general",
      createdBy: owner.id,
    });

    expect(await mover(conOrden, PASADO, "16:00")).toEqual({
      ok: false,
      code: "not_reschedulable",
    });
  });

  it("avisa cuando no hay nada que mover y cuando la reserva no existe", async () => {
    const booking = await crear();

    expect(await mover(booking, MANANA, "16:30")).toEqual({ ok: false, code: "unchanged" });
    expect(
      await rescheduleBooking(
        db,
        owner,
        { bookingId: "11111111-1111-4111-8111-111111111111", serviceDate: PASADO, start: "16:00" },
        NOW,
      ),
    ).toEqual({ ok: false, code: "not_found" });
  });

  it("audita el cambio con el antes y el después, sin datos personales", async () => {
    const booking = await crear();

    await mover(booking, PASADO, "15:30");

    const entradas = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "booking.rescheduled"));
    expect(entradas).toHaveLength(1);
    expect(entradas[0]?.entityId).toBe(booking.id);
    expect(entradas[0]?.actorUserId).toBe(owner.id);
    expect(entradas[0]?.details).toMatchObject({
      before: { serviceDate: MANANA, start: "16:30" },
      after: { serviceDate: PASADO, start: "15:30" },
    });
    const detalle = JSON.stringify(entradas[0]?.details ?? {});
    expect(detalle).not.toContain("patricia@ejemplo.cl");
    expect(detalle).not.toContain("+56911111111");
  });

  it("recepción puede reprogramar y el mecánico no", async () => {
    const booking = await crear();
    const reception = await seedUser("reception");
    const mechanic = await seedUser("mechanic");

    expect(await mover(booking, PASADO, "16:00", mechanic)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await activos(MANANA)).toEqual(["16:30"]);
    expect(await mover(booking, PASADO, "16:00", reception)).toMatchObject({ ok: true });
  });

  it("entre dos reprogramaciones al mismo bloque gana exactamente una", async () => {
    const una = await crear({ start: "15:00" });
    const otra = await crear({ start: "15:30", phoneE164: "+56922222222", email: null });

    const resultados = await Promise.all([
      mover(una, PASADO, "17:00"),
      mover(otra, PASADO, "17:00"),
    ]);

    expect(resultados.filter((resultado) => resultado.ok)).toHaveLength(1);
    expect(await activos(PASADO)).toEqual(["17:00"]);
  });

  it("dos reprogramaciones cruzadas terminan sin trabarse", async () => {
    const una = await crear({ start: "15:00" });
    const otra = await crear({
      serviceDate: PASADO,
      start: "15:00",
      phoneE164: "+56922222222",
      email: null,
    });

    const resultados = await Promise.all([
      mover(una, PASADO, "16:00"),
      mover(otra, MANANA, "16:00"),
    ]);

    expect(resultados.every((resultado) => resultado.ok)).toBe(true);
    expect(await activos(MANANA)).toEqual(["16:00"]);
    expect(await activos(PASADO)).toEqual(["16:00"]);
  });
});
