import { and, eq, ne, sql } from "drizzle-orm";
import type { AppDb } from "../db/client.ts";
import { blockedPeriods, bookingBlocks, bookings } from "../db/schema.ts";

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** Estado de la fecha leído dentro de la transacción, ya con el lock tomado. */
export async function readDay(tx: Tx, serviceDate: string, excludeBookingId?: string) {
  const activeBlocks = await tx
    .select({ blockStart: bookingBlocks.blockStart })
    .from(bookingBlocks)
    .where(
      and(
        eq(bookingBlocks.serviceDate, serviceDate),
        eq(bookingBlocks.isActive, true),
        excludeBookingId === undefined ? undefined : ne(bookingBlocks.bookingId, excludeBookingId),
      ),
    );
  const blocked = await tx
    .select({ startTime: blockedPeriods.startTime, endTime: blockedPeriods.endTime })
    .from(blockedPeriods)
    .where(eq(blockedPeriods.serviceDate, serviceDate));
  const [used] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bookings)
    .where(
      and(
        eq(bookings.serviceDate, serviceDate),
        ne(bookings.status, "cancelled"),
        excludeBookingId === undefined ? undefined : ne(bookings.id, excludeBookingId),
      ),
    );

  return {
    activeBlockStarts: activeBlocks.map((row) => row.blockStart.slice(0, 5)),
    blocked: blocked.map((row) => ({
      startTime: row.startTime === null ? null : row.startTime.slice(0, 5),
      endTime: row.endTime === null ? null : row.endTime.slice(0, 5),
    })),
    usedCount: Number(used?.n ?? 0),
  };
}
