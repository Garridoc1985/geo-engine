import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/lib/log.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import { hashCancelToken } from "../../src/server/booking/tokens.ts";
import {
  bookingBlocks,
  bookingDays,
  bookingRequests,
  bookings,
} from "../../src/server/db/schema.ts";
import * as transport from "../../src/server/email/transport.ts";
import {
  createManualBooking,
  freeBlocks,
  listUpcomingBookings,
  manualBookingSchema,
} from "../../src/server/taller/manual-booking.ts";
import type { ManualBookingInput } from "../../src/server/taller/manual-booking.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-09-15T15:00:00.000Z");
const ACTOR: SessionUser = {
  id: "00000000-0000-4000-8000-000000000001",
  branchId: "00000000-0000-4000-8000-000000000002",
  name: "Recepción",
  email: "recepcion@ejemplo.cl",
  role: "reception",
};
const noMail = { notify: async () => {} };
function input(overrides: Partial<ManualBookingInput> = {}): ManualBookingInput {
  return {
    mode: "taller",
    service_date: "2026-09-16",
    start: "16:30",
    nombre: "Javiera Rojas",
    telefono: "911111111",
    correo: "javiera@ejemplo.cl",
    bicicleta: "Ruta Specialized",
    descripcion: "Cambio de cadena y ajuste de frenos",
    source: "telefono",
    consentimiento: true,
    ...overrides,
  };
}

describe("reservas manuales", () => {
  let test: TestDb;
  beforeEach(async () => {
    test = await createTestDb();
    transport.consoleOutbox.length = 0;
    vi.spyOn(log, "info").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    transport.consoleOutbox.length = 0;
    await test.close();
  });

  it("1: guarda teléfono como origen y mantiene web por defecto", async () => {
    const manual = await createManualBooking(test.db, ACTOR, input(), NOW, noMail);
    expect(manual.ok).toBe(true);
    if (!manual.ok) throw new Error(manual.code);
    expect(manual.booking.source).toBe("telefono");
    expect(manual.booking.phoneE164).toBe("+56911111111");
    expect(manual.booking.ipHash).toBeNull();
    expect(manual.booking.whatsappConsentAt).toBeNull();
    const web = await createBooking(
      test.db,
      {
        mode: "taller",
        serviceDate: "2026-09-16",
        start: "17:00",
        customerName: "Cliente web",
        phoneE164: "+56922222222",
        email: "web@ejemplo.cl",
        bike: "Urbana",
        description: "Mantención general",
        comuna: null,
        address: null,
        ipHash: null,
      },
      NOW,
    );
    if (!web.ok) throw new Error(web.code);
    expect(web.booking.source).toBe("web");
    expect((await test.db.select().from(bookings)).map((row) => row.source)).toEqual([
      "telefono",
      "web",
    ]);
    expect(await test.db.select().from(bookingRequests)).toHaveLength(0);
  });

  it("2: acepta cuatro bloques diferentes y rechaza la quinta reserva diaria", async () => {
    for (const [index, start] of ["15:00", "15:30", "16:00", "16:30"].entries()) {
      const result = await createManualBooking(
        test.db,
        ACTOR,
        input({ start, telefono: `93000000${index}` }),
        NOW,
        noMail,
      );
      expect(result.ok).toBe(true);
    }
    const fifth = await createManualBooking(
      test.db,
      ACTOR,
      input({ start: "17:00", telefono: "930000009" }),
      NOW,
      noMail,
    );
    expect(fifth).toEqual({ ok: false, code: "slot_unavailable" });
    expect(await test.db.select().from(bookings)).toHaveLength(4);
    expect(await test.db.select().from(bookingBlocks)).toHaveLength(4);
    expect(await freeBlocks(test.db, "2026-09-16", "taller", NOW)).toEqual([]);
  });

  it("3: acepta exactamente una de veinte reservas concurrentes al mismo bloque", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createManualBooking(
          test.db,
          ACTOR,
          input({ telefono: `9${10000000 + index}` }),
          NOW,
          noMail,
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.code === "slot_unavailable"),
    ).toHaveLength(19);
    const active = await test.db
      .select()
      .from(bookingBlocks)
      .where(eq(bookingBlocks.isActive, true));
    expect(active).toHaveLength(1);
    expect(active[0]?.blockStart).toBe("16:30:00");
    expect(await test.db.select().from(bookings)).toHaveLength(1);
  });

  it("4: rechaza un teléfono que ya tiene una reserva futura", async () => {
    expect((await createManualBooking(test.db, ACTOR, input(), NOW, noMail)).ok).toBe(true);
    const notify = vi.fn();
    const result = await createManualBooking(
      test.db,
      ACTOR,
      input({ service_date: "2026-09-17" }),
      NOW,
      { notify },
    );
    expect(result).toEqual({ ok: false, code: "phone_limit" });
    expect(notify).not.toHaveBeenCalled();
    expect(await test.db.select().from(bookings)).toHaveLength(1);
  });

  it("5: el notify por defecto envía Reserva confirmada después del commit", async () => {
    let insideTransaction = false;
    const transaction = test.db.transaction.bind(test.db);
    vi.spyOn(test.db, "transaction").mockImplementation(async (...args) => {
      insideTransaction = true;
      try {
        return await transaction(...args);
      } finally {
        insideTransaction = false;
      }
    });
    const createTransport = transport.createTransport;
    vi.spyOn(transport, "createTransport").mockImplementation((env) => {
      const sender = createTransport(env);
      return {
        send: async (message) => {
          expect(insideTransaction).toBe(false);
          expect(await test.db.select().from(bookings)).toHaveLength(1);
          await sender.send(message);
        },
      };
    });
    const result = await createManualBooking(test.db, ACTOR, input(), NOW);
    if (!result.ok) throw new Error(result.code);
    expect(transport.consoleOutbox).toHaveLength(2);
    const confirmation = transport.consoleOutbox.find((entry) => entry.to === input().correo);
    expect(confirmation?.subject).toContain("Reserva confirmada");
    expect(confirmation?.attachments?.[0]?.content).toContain("BEGIN:VCALENDAR");
    expect(confirmation?.text).toContain(result.cancelToken);
    expect(result.booking.cancelTokenHash).toBe(hashCancelToken(result.cancelToken));
    expect(result.booking.cancelTokenHash).not.toBe(result.cancelToken);
  });

  it("6: devuelve forbidden al mecánico sin consultar ni escribir filas", async () => {
    const select = vi.spyOn(test.db, "select");
    const insert = vi.spyOn(test.db, "insert");
    const transaction = vi.spyOn(test.db, "transaction");
    const notify = vi.fn();
    const result = await createManualBooking(
      test.db,
      { ...ACTOR, role: "mechanic" },
      input(),
      NOW,
      { notify },
    );
    expect(result).toEqual({ ok: false, code: "forbidden" });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await test.db.select().from(bookings)).toHaveLength(0);
    expect(await test.db.select().from(bookingDays)).toHaveLength(0);
  });

  it.each([undefined, ""])(
    "sin correo (%s) crea la reserva y envía solo el aviso al taller",
    async (correo) => {
      const data = input({ correo });
      if (correo === undefined) delete data.correo;
      const result = await createManualBooking(test.db, ACTOR, data, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.booking.email).toBeNull();
      const [stored] = await test.db
        .select()
        .from(bookings)
        .where(eq(bookings.id, result.booking.id));
      expect(stored?.email).toBeNull();
      expect(transport.consoleOutbox).toHaveLength(1);
      expect(transport.consoleOutbox[0]?.to).toBe("info@vectorbikes.cl");
      expect(transport.consoleOutbox[0]?.subject).toBe(`Nueva reserva ${result.booking.code}`);
      expect(transport.consoleOutbox[0]?.attachments).toBeUndefined();
    },
  );

  it("valida estrictamente el correo, origen, consentimiento y dirección de retiro", () => {
    for (const changes of [
      { correo: "inválido" },
      { source: "web" },
      { consentimiento: false },
      { mode: "retiro" },
      { turnstile_token: "token" },
      { service_date: "2026-02-30" },
      { comuna: "Vitacura" },
      { direccion: "Kennedy 7666" },
    ])
      expect(manualBookingSchema.safeParse({ ...input(), ...changes }).success).toBe(false);
    expect(
      manualBookingSchema.safeParse(
        input({ mode: "retiro", comuna: "Vitacura", direccion: "Kennedy 7666" }),
      ).success,
    ).toBe(true);
  });

  it("un correo inválido no escribe filas ni notifica", async () => {
    const notify = vi.fn();
    expect(
      await createManualBooking(test.db, ACTOR, input({ correo: "inválido" }), NOW, { notify }),
    ).toEqual({ ok: false, code: "validation_error" });
    expect(await test.db.select().from(bookings)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("un fallo del notificador conserva la reserva y registra solo kind y code", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const result = await createManualBooking(test.db, ACTOR, input(), NOW, {
      notify: async () => {
        throw new Error("correo privado javiera@ejemplo.cl 911111111");
      },
    });
    if (!result.ok) throw new Error(result.code);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith("email.failed", {
      kind: "manual_booking",
      code: result.booking.code,
    });
    expect(await test.db.select().from(bookings)).toHaveLength(1);
  });

  it("retiro ocupa dos bloques y disponibilidad y listado respetan agenda y estados", async () => {
    const result = await createManualBooking(
      test.db,
      ACTOR,
      input({
        mode: "retiro",
        start: "16:00",
        comuna: "Las Condes",
        direccion: "Apoquindo 100",
        source: "whatsapp",
      }),
      NOW,
      noMail,
    );
    if (!result.ok) throw new Error(result.code);
    expect(result.booking.source).toBe("whatsapp");
    expect(result.booking.pickupFeeClp).toBe(15000);
    expect((await test.db.select().from(bookingBlocks)).map((row) => row.blockStart)).toEqual([
      "16:00:00",
      "16:30:00",
    ]);
    const free = await freeBlocks(test.db, "2026-09-16", "retiro", NOW);
    expect(free.map((block) => block.start)).not.toContain("15:30");
    expect(free.map((block) => block.start)).not.toContain("16:00");
    expect(free.map((block) => block.start)).not.toContain("19:30");
    expect(free.map((block) => block.start)).toContain("17:00");
    expect(await freeBlocks(test.db, "2026-09-18", "taller", NOW)).toEqual([]);
    expect(await listUpcomingBookings(test.db, "2026-09-16", 1)).toHaveLength(1);
    expect(await listUpcomingBookings(test.db, "2026-09-17")).toHaveLength(0);
    await test.db
      .update(bookings)
      .set({ status: "ready_for_pickup" })
      .where(eq(bookings.id, result.booking.id));
    expect(await listUpcomingBookings(test.db, "2026-09-16")).toHaveLength(1);
    await test.db
      .update(bookings)
      .set({ status: "completed" })
      .where(eq(bookings.id, result.booking.id));
    expect(await listUpcomingBookings(test.db, "2026-09-16")).toHaveLength(0);
  });
});
