import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { errorMessage, log } from "../../lib/log.ts";
import type { AppDb } from "../db/client.ts";
import { type Booking, bookings } from "../db/schema.ts";
import { notifyBookingCancelled } from "../email/notifications.ts";
import { cancelBooking } from "./cancel-booking.ts";
import { type BookingMode, TIMEZONE } from "./rules.ts";
import { hashCancelToken } from "./tokens.ts";

/** Lo mínimo para que el cliente reconozca su reserva; sin datos de contacto. */
export type CancellationSummary = {
  code: string;
  dateLabel: string;
  start: string;
  end: string;
  mode: BookingMode;
  pickupFeeClp: number;
};

export type CancellationView =
  | { view: "invalid" }
  | { view: "cancelled" | "started" | "confirm" | "done"; booking: CancellationSummary };

export type CancellationDeps = {
  notify?: (booking: Booking) => Promise<void>;
};

/** `newCancelToken` produce 43 caracteres base64url; cualquier otra forma no llega a la base. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

function summarize(booking: Booking): CancellationSummary {
  const local = (instant: Date) =>
    DateTime.fromJSDate(instant).setZone(TIMEZONE).setLocale("es-CL");
  return {
    code: booking.code,
    dateLabel: local(booking.startsAt).toFormat("cccc d 'de' LLLL 'de' yyyy"),
    start: local(booking.startsAt).toFormat("HH:mm"),
    end: local(booking.endsAt).toFormat("HH:mm"),
    mode: booking.mode === "retiro" ? "retiro" : "taller",
    pickupFeeClp: booking.pickupFeeClp,
  };
}

async function findByToken(db: AppDb, rawToken: unknown): Promise<Booking | null> {
  const parsed = tokenSchema.safeParse(rawToken);
  if (!parsed.success) {
    return null;
  }
  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.cancelTokenHash, hashCancelToken(parsed.data)))
    .limit(1);
  return booking ?? null;
}

/** Vista sin efectos: qué puede hacer el cliente con este token en este momento. */
function stateOf(booking: Booking, now: Date): "cancelled" | "started" | "confirm" {
  if (booking.status === "cancelled") {
    return "cancelled";
  }
  if (
    (booking.status !== "confirmed" && booking.status !== "ready_for_pickup") ||
    booking.startsAt.getTime() <= now.getTime()
  ) {
    return "started";
  }
  return "confirm";
}

export async function viewCancellation(
  db: AppDb,
  token: unknown,
  now: Date,
): Promise<CancellationView> {
  const booking = await findByToken(db, token);
  if (!booking) {
    return { view: "invalid" };
  }
  return { view: stateOf(booking, now), booking: summarize(booking) };
}

/** Cancela con el token; el aviso al taller va después del commit y nunca revierte la cancelación. */
export async function performCancellation(
  db: AppDb,
  token: unknown,
  now: Date,
  deps: CancellationDeps = {},
): Promise<CancellationView> {
  const booking = await findByToken(db, token);
  if (!booking) {
    return { view: "invalid" };
  }
  const state = stateOf(booking, now);
  if (state !== "confirm") {
    return { view: state, booking: summarize(booking) };
  }

  const result = await cancelBooking(db, { bookingId: booking.id, by: "customer", now });
  if (!result.ok) {
    const view = result.code === "already_cancelled" ? "cancelled" : "started";
    return result.code === "not_found"
      ? { view: "invalid" }
      : { view, booking: summarize(booking) };
  }

  const notify = deps.notify ?? ((cancelled: Booking) => notifyBookingCancelled(cancelled));
  try {
    await notify(result.booking);
  } catch (error) {
    log.error("email.failed", {
      kind: "shop_cancellation",
      code: booking.code,
      message: errorMessage(error),
    });
  }
  log.info("booking.cancelled", { code: booking.code, by: "customer" });
  return { view: "done", booking: summarize(result.booking) };
}
