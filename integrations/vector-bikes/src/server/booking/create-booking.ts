import { and, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { type AppDb, isUniqueViolation } from "../db/client.ts";
import { type Booking, bookingBlocks, bookingDays, bookings } from "../db/schema.ts";
import { readDay } from "./day-state.ts";
import { PICKUP_FEE_CLP } from "./rules.ts";
import type { BookingMode } from "./rules.ts";
import { checkStart } from "./slots.ts";
import { hashCancelToken, newCancelToken } from "./tokens.ts";

export type BookingSource = "web" | "telefono" | "whatsapp" | "presencial";

export type CreateBookingInput = {
  mode: BookingMode;
  serviceDate: string;
  start: string;
  customerName: string;
  phoneE164: string;
  email: string | null;
  bike: string;
  description: string;
  comuna: string | null;
  address: string | null;
  ipHash: string | null;
  whatsappConsent?: boolean;
  source?: BookingSource;
};

export type CreateBookingResult =
  | { ok: true; booking: Booking; cancelToken: string }
  | { ok: false; code: "slot_unavailable" | "phone_limit" };

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** `VB-AAMMDD-HHMM`, con sufijo `-n` si el bloque ya tuvo reservas (incluidas las canceladas). */
async function nextCode(tx: Tx, serviceDate: string, start: string): Promise<string> {
  const base = `VB-${serviceDate.slice(2).replaceAll("-", "")}-${start.replace(":", "")}`;
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bookings)
    .where(or(eq(bookings.code, base), like(bookings.code, `${base}-%`)));
  const n = Number(row?.n ?? 0);
  return n === 0 ? base : `${base}-${n + 1}`;
}

async function insertBooking(
  tx: Tx,
  input: CreateBookingInput,
  now: Date,
  slot: { blockStarts: string[]; startsAt: Date; endsAt: Date },
  cancelToken: string,
): Promise<Booking> {
  const [booking] = await tx
    .insert(bookings)
    .values({
      code: await nextCode(tx, input.serviceDate, input.start),
      serviceDate: input.serviceDate,
      mode: input.mode,
      status: "confirmed",
      source: input.source ?? "web",
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      customerName: input.customerName,
      phoneE164: input.phoneE164,
      email: input.email,
      bike: input.bike,
      description: input.description,
      comuna: input.comuna,
      address: input.address,
      pickupFeeClp: input.mode === "retiro" ? PICKUP_FEE_CLP : 0,
      consentAt: now,
      whatsappConsentAt: input.whatsappConsent === true ? now : null,
      cancelTokenHash: hashCancelToken(cancelToken),
      ipHash: input.ipHash,
    })
    .returning();

  if (!booking) {
    throw new Error("el insert de la reserva no devolvió fila");
  }

  await tx.insert(bookingBlocks).values(
    slot.blockStarts.map((blockStart) => ({
      bookingId: booking.id,
      serviceDate: input.serviceDate,
      blockStart: `${blockStart}:00`,
      isActive: true,
    })),
  );

  return booking;
}

/**
 * Escribe una reserva revalidando todas las reglas dentro de la transacción.
 * Orden de locks fijo: `booking_days` FOR UPDATE → advisory lock por teléfono.
 * Nada de red ni correos aquí dentro: se notifica después del commit.
 */
export async function createBooking(
  db: AppDb,
  input: CreateBookingInput,
  now: Date,
): Promise<CreateBookingResult> {
  const cancelToken = newCancelToken();
  try {
    return await db.transaction(async (tx) => {
      await tx.insert(bookingDays).values({ serviceDate: input.serviceDate }).onConflictDoNothing();
      await tx
        .select({ serviceDate: bookingDays.serviceDate })
        .from(bookingDays)
        .where(eq(bookingDays.serviceDate, input.serviceDate))
        .for("update");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.phoneE164}))`);

      const [future] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.phoneE164, input.phoneE164),
            inArray(bookings.status, ["confirmed", "ready_for_pickup"]),
            gt(bookings.startsAt, now),
          ),
        )
        .limit(1);
      if (future) {
        return { ok: false, code: "phone_limit" };
      }

      const day = await readDay(tx, input.serviceDate);
      const slot = checkStart({
        date: input.serviceDate,
        mode: input.mode,
        now,
        start: input.start,
        ...day,
      });
      if (!slot.ok) {
        return { ok: false, code: "slot_unavailable" };
      }

      const booking = await insertBooking(tx, input, now, slot, cancelToken);
      return { ok: true, booking, cancelToken };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, code: "slot_unavailable" };
    }
    throw error;
  }
}
