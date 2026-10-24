import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { errorMessage, log } from "../../lib/log.ts";
import { addDays, localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { bookings } from "../db/schema.ts";
import { reminderEmail } from "./templates.ts";
import { createTransport, type EmailTransport } from "./transport.ts";

export type ReminderDeps = { transport: EmailTransport };

/**
 * Recordatorio a las reservas confirmadas de mañana (fecha local) que aún no lo recibieron.
 * No importa `notifications.ts`: el script programado no necesita cargar `ics`.
 */
export async function sendReminders(
  db: AppDb,
  now: Date,
  deps: ReminderDeps = { transport: createTransport() },
): Promise<{ sent: number; failed: number }> {
  const tomorrow = addDays(localToday(now), 1);
  const pending = await db
    .select()
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ["confirmed", "ready_for_pickup"]),
        eq(bookings.serviceDate, tomorrow),
        isNull(bookings.reminderSentAt),
        isNotNull(bookings.email),
      ),
    )
    .orderBy(asc(bookings.startsAt));

  let sent = 0;
  let failed = 0;
  for (const booking of pending) {
    if (booking.email === null) {
      continue;
    }
    try {
      await deps.transport.send({ to: booking.email, ...reminderEmail(booking) });
    } catch (error) {
      failed += 1;
      log.error("email.failed", {
        kind: "reminder",
        code: booking.code,
        message: errorMessage(error),
      });
      continue;
    }
    await db
      .update(bookings)
      .set({ reminderSentAt: now })
      .where(and(eq(bookings.id, booking.id), isNull(bookings.reminderSentAt)));
    sent += 1;
  }
  return { sent, failed };
}
