import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client.ts";
import { type Booking, bookingBlocks, bookings } from "../db/schema.ts";

export type CancelBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; code: "not_found" | "already_cancelled" | "not_cancellable" | "started" };

export async function cancelBooking(
  db: AppDb,
  args: { bookingId: string; by: "customer" | "admin"; now: Date },
): Promise<CancelBookingResult> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, args.bookingId))
      .for("update");

    if (!booking) {
      return { ok: false, code: "not_found" };
    }
    if (booking.status === "cancelled") {
      return { ok: false, code: "already_cancelled" };
    }
    if (booking.status === "completed" || booking.status === "no_show") {
      return { ok: false, code: "not_cancellable" };
    }
    if (args.by === "customer" && booking.startsAt.getTime() <= args.now.getTime()) {
      return { ok: false, code: "started" };
    }

    const [cancelled] = await tx
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: args.now,
        cancelledBy: args.by,
        ...(args.by === "customer" ? { cancelTokenUsedAt: args.now } : {}),
      })
      .where(eq(bookings.id, booking.id))
      .returning();

    await tx
      .update(bookingBlocks)
      .set({ isActive: false })
      .where(eq(bookingBlocks.bookingId, booking.id));

    if (!cancelled) {
      throw new Error("la cancelación no devolvió la reserva");
    }
    return { ok: true, booking: cancelled };
  });
}
