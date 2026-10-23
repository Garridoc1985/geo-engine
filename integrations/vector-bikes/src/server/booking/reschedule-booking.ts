import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { errorMessage, log } from "../../lib/log.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { type AppDb, isUniqueViolation } from "../db/client.ts";
import { workOrders } from "../db/schema-orders.ts";
import { type Booking, bookingBlocks, bookingDays, bookings } from "../db/schema.ts";
import { notifyBookingRescheduled } from "../email/notifications.ts";
import type { NotifyDeps } from "../email/notifications.ts";
import { recordAudit } from "../taller/audit.ts";
import { readDay } from "./day-state.ts";
import { TIMEZONE } from "./rules.ts";
import type { BookingMode } from "./rules.ts";
import { type CheckStartResult, checkStart } from "./slots.ts";

export type RescheduleResult =
  | { ok: true; booking: Booking; previous: { serviceDate: string; start: string } }
  | {
      ok: false;
      code:
        | "forbidden"
        | "not_found"
        | "not_reschedulable"
        | "unchanged"
        | "slot_unavailable"
        | "phone_limit";
    };

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
type RescheduleArgs = { bookingId: string; serviceDate: string; start: string };
type Schedule = { serviceDate: string; start: string };
type AvailableSlot = Extract<CheckStartResult, { ok: true }>;

/** `bookings.mode` es texto en la base; el CHECK `bookings_mode_check` la limita a estos dos. */
function bookingMode(mode: string): BookingMode {
  if (mode !== "taller" && mode !== "retiro") {
    throw new Error("La reserva tiene una modalidad desconocida.");
  }
  return mode;
}

/** Las fechas se bloquean en orden antes de tomar el lock del teléfono. */
async function lockDaysAndPhone(tx: Tx, booking: Booking, serviceDate: string) {
  const dates = [...new Set([booking.serviceDate, serviceDate])].sort();
  for (const date of dates) {
    await tx.insert(bookingDays).values({ serviceDate: date }).onConflictDoNothing();
    await tx
      .select({ serviceDate: bookingDays.serviceDate })
      .from(bookingDays)
      .where(eq(bookingDays.serviceDate, date))
      .for("update");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${booking.phoneE164}))`);
}

async function hasOtherFutureBooking(tx: Tx, booking: Booking, now: Date): Promise<boolean> {
  const [future] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.phoneE164, booking.phoneE164),
        ne(bookings.id, booking.id),
        inArray(bookings.status, ["confirmed", "ready_for_pickup"]),
        gt(bookings.startsAt, now),
      ),
    )
    .limit(1);
  return future !== undefined;
}

async function moveBlocks(tx: Tx, args: RescheduleArgs, slot: AvailableSlot): Promise<void> {
  await tx
    .update(bookingBlocks)
    .set({ isActive: false })
    .where(eq(bookingBlocks.bookingId, args.bookingId));
  await tx.insert(bookingBlocks).values(
    slot.blockStarts.map((blockStart) => ({
      bookingId: args.bookingId,
      serviceDate: args.serviceDate,
      blockStart: `${blockStart}:00`,
      isActive: true,
    })),
  );
}

async function updateAndAudit(
  tx: Tx,
  actor: SessionUser,
  args: RescheduleArgs,
  slot: AvailableSlot,
  previous: Schedule,
  now: Date,
): Promise<RescheduleResult> {
  await moveBlocks(tx, args, slot);
  const [booking] = await tx
    .update(bookings)
    .set({
      serviceDate: args.serviceDate,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      reminderSentAt: null,
    })
    .where(eq(bookings.id, args.bookingId))
    .returning();
  if (!booking) throw new Error("La reprogramación no devolvió la reserva.");
  await recordAudit(
    tx,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action: "booking.rescheduled",
      entity: "booking",
      entityId: booking.id,
      details: { before: previous, after: { serviceDate: args.serviceDate, start: args.start } },
    },
    now,
  );
  return { ok: true, booking, previous };
}

async function rescheduleInTransaction(
  tx: Tx,
  actor: SessionUser,
  args: RescheduleArgs,
  now: Date,
): Promise<RescheduleResult> {
  const [booking] = await tx
    .select()
    .from(bookings)
    .where(eq(bookings.id, args.bookingId))
    .for("update");
  if (!booking) return { ok: false, code: "not_found" };
  if (booking.status !== "confirmed") return { ok: false, code: "not_reschedulable" };
  const [order] = await tx
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(eq(workOrders.bookingId, booking.id))
    .limit(1);
  if (order) return { ok: false, code: "not_reschedulable" };
  const previous = {
    serviceDate: booking.serviceDate,
    start: DateTime.fromJSDate(booking.startsAt).setZone(TIMEZONE).toFormat("HH:mm"),
  };
  if (previous.serviceDate === args.serviceDate && previous.start === args.start) {
    return { ok: false, code: "unchanged" };
  }
  await lockDaysAndPhone(tx, booking, args.serviceDate);
  if (await hasOtherFutureBooking(tx, booking, now)) return { ok: false, code: "phone_limit" };
  const day = await readDay(tx, args.serviceDate, booking.id);
  const slot = checkStart({
    date: args.serviceDate,
    mode: bookingMode(booking.mode),
    now,
    start: args.start,
    ...day,
  });
  if (!slot.ok) return { ok: false, code: "slot_unavailable" };
  return updateAndAudit(tx, actor, args, slot, previous, now);
}

/** Reprograma la misma reserva y audita el cambio dentro de una sola transacción. */
export async function rescheduleBooking(
  db: AppDb,
  actor: SessionUser,
  args: { bookingId: string; serviceDate: string; start: string },
  now: Date,
  deps: NotifyDeps = {},
): Promise<RescheduleResult> {
  if (!can(actor.role, "bookings.manage")) return { ok: false, code: "forbidden" };
  let result: RescheduleResult;
  try {
    result = await db.transaction((tx) => rescheduleInTransaction(tx, actor, args, now));
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "slot_unavailable" };
    throw error;
  }
  if (result.ok) {
    try {
      await notifyBookingRescheduled(result.booking, result.previous, deps);
    } catch (error) {
      log.error("email.rescheduled_failed", {
        code: result.booking.code,
        message: errorMessage(error),
      });
    }
  }
  return result;
}
