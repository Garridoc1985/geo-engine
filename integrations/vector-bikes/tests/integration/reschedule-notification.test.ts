import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { type CreateBookingInput, createBooking } from "../../src/server/booking/create-booking.ts";
import { rescheduleBooking } from "../../src/server/booking/reschedule-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { type Booking, bookings, branches, users } from "../../src/server/db/schema.ts";
import { ICS_FILENAME } from "../../src/server/email/notifications.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import type { EmailTransport } from "../../src/server/email/transport.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const MANANA = "2026-09-16";
const PASADO = "2026-09-17";
const CLIENTE = "patricia@ejemplo.cl";

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
    email: CLIENTE,
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
  consoleOutbox.length = 0;
  return result.booking;
}

function mover(booking: Booking, start = "15:30", deps?: { transport: EmailTransport }) {
  return rescheduleBooking(
    db,
    owner,
    { bookingId: booking.id, serviceDate: PASADO, start },
    NOW,
    deps,
  );
}

function paraElCliente() {
  return consoleOutbox.filter((mail) => mail.to === CLIENTE);
}

beforeEach(async () => {
  consoleOutbox.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("red deshabilitada en tests");
    }),
  );
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
  return async () => {
    vi.unstubAllGlobals();
    await test.close();
  };
});

describe("aviso de reserva reprogramada", () => {
  it("avisa al cliente y al taller, con el calendario actualizado", async () => {
    const booking = await crear();

    expect(await mover(booking)).toMatchObject({ ok: true });

    const [cliente] = paraElCliente();
    expect(cliente?.subject).toContain("Cambiamos tu reserva");
    expect(cliente?.subject).toContain(booking.code);
    expect(cliente?.text).toContain("17 de septiembre");
    expect(cliente?.text).toContain("16 de septiembre");
    expect(consoleOutbox.filter((mail) => mail.to !== CLIENTE)).toHaveLength(1);
  });

  it("el .ics mantiene el UID y sube el SEQUENCE para mover el evento, no duplicarlo", async () => {
    const booking = await crear();

    await mover(booking);

    const adjunto = paraElCliente()[0]?.attachments?.[0];
    expect(adjunto?.filename).toBe(ICS_FILENAME);
    expect(adjunto?.content).toContain(`UID:${booking.code}@vectorbikes.cl`);
    const sequence = Number(/SEQUENCE:(\d+)/.exec(adjunto?.content ?? "")?.[1] ?? "-1");
    expect(sequence).toBeGreaterThan(0);
    // El evento nuevo apunta al bloque nuevo, no al viejo.
    expect(adjunto?.content).toContain("20260917");
  });

  it("sin correo del cliente no se le escribe y la reprogramación queda hecha", async () => {
    const booking = await crear({ email: null });

    expect(await mover(booking)).toMatchObject({ ok: true });

    expect(paraElCliente()).toHaveLength(0);
    const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(stored?.serviceDate).toBe(PASADO);
  });

  it("si el transporte falla, la reprogramación queda hecha igual", async () => {
    const booking = await crear();
    const flaky: EmailTransport = {
      send: async () => {
        throw new Error("el proveedor rechazó el correo");
      },
    };

    expect(await mover(booking, "15:30", { transport: flaky })).toMatchObject({ ok: true });

    expect(consoleOutbox).toHaveLength(0);
    const [stored] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(stored?.serviceDate).toBe(PASADO);
  });

  it("una reprogramación rechazada no manda nada", async () => {
    const booking = await crear();
    await crear({ serviceDate: PASADO, start: "15:30", phoneE164: "+56922222222", email: null });

    expect(await mover(booking)).toEqual({ ok: false, code: "slot_unavailable" });

    expect(consoleOutbox).toHaveLength(0);
  });
});
