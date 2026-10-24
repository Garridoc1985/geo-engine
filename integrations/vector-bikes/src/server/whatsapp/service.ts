import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getWhatsAppEnv } from "../../lib/env.ts";
import { errorMessage, log } from "../../lib/log.ts";
import { TIMEZONE } from "../booking/rules.ts";
import type { AppDb } from "../db/client.ts";
import { type Booking, bookings, whatsappMessages } from "../db/schema.ts";

export type NoticeResult = { status: "sent" | "failed" | "skipped"; reason?: string };
type Kind = "reminder" | "ready";
type Sender = (booking: Booking, kind: Kind) => Promise<string>;
const liveSends = new Set<string>();

export function whatsappAvailability(): { enabled: boolean; reason: string } {
  try {
    const env = getWhatsAppEnv();
    return env.WHATSAPP_ENABLED === "true"
      ? { enabled: true, reason: "WhatsApp habilitado" }
      : {
          enabled: false,
          reason: "WhatsApp deshabilitado: las reservas y los correos siguen funcionando",
        };
  } catch (error) {
    return { enabled: false, reason: errorMessage(error) };
  }
}

/** Meta template placeholders are positional and must match the approved templates. */
export async function sendTemplate(booking: Booking, kind: Kind): Promise<string> {
  const env = getWhatsAppEnv();
  if (env.WHATSAPP_ENABLED !== "true") throw new Error("WhatsApp no está habilitado");
  const time = DateTime.fromJSDate(booking.startsAt).setZone(TIMEZONE);
  const variables =
    kind === "reminder"
      ? [booking.customerName, time.toFormat("dd/MM/yyyy"), time.toFormat("HH:mm"), booking.code]
      : [booking.customerName, booking.bike, booking.code];
  const template =
    kind === "reminder" ? env.WHATSAPP_REMINDER_TEMPLATE : env.WHATSAPP_READY_TEMPLATE;
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: booking.phoneE164.replace(/^\+/, ""),
      type: "template",
      template: {
        name: template,
        language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE },
        components: [
          {
            type: "body",
            parameters: variables.map((text) => ({ type: "text", text })),
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Meta errors may contain customer data or credentials: never log their response body.
    throw new Error(`Meta rechazó la plantilla (HTTP ${response.status})`);
  }
  const payload: unknown = await response.json();
  const id = (payload as { messages?: { id?: string }[] }).messages?.[0]?.id;
  if (!id) throw new Error("Meta respondió sin identificador de mensaje");
  return id;
}

/**
 * A unique booking/type row and an atomic claim prevent concurrent sends. A lost HTTP
 * response is ambiguous: leave it "unknown" rather than automatically duplicating it.
 */
export async function sendNotice(
  db: AppDb,
  booking: Booking,
  kind: Kind,
  now: Date,
  sender: Sender = sendTemplate,
): Promise<NoticeResult> {
  const enteredAt = Date.now();
  try {
    const env = getWhatsAppEnv();
    if (env.WHATSAPP_ENABLED !== "true")
      return { status: "skipped", reason: "WhatsApp no configurado" };
  } catch (error) {
    return { status: "failed", reason: errorMessage(error) };
  }

  const claim = await db.transaction(async (tx) => {
    const [fresh] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id))
      .for("update");
    const currentNow = new Date(now.getTime() + Date.now() - enteredAt);
    if (!fresh?.whatsappConsentAt) return { reason: "Sin consentimiento WhatsApp" };
    if (kind === "ready" && fresh.status !== "ready_for_pickup")
      return { reason: "La bicicleta no está lista" };
    if (kind === "reminder" && (fresh.status !== "confirmed" || fresh.startsAt <= currentNow)) {
      return { reason: "Reserva no confirmada o ya iniciada" };
    }
    await tx
      .insert(whatsappMessages)
      .values({ bookingId: fresh.id, type: kind })
      .onConflictDoNothing();
    const [claimed] = await tx
      .update(whatsappMessages)
      .set({
        status: "sending",
        attempts: sql`${whatsappMessages.attempts} + 1`,
        claimedAt: new Date(),
        error: null,
      })
      .where(
        and(
          eq(whatsappMessages.bookingId, fresh.id),
          eq(whatsappMessages.type, kind),
          inArray(whatsappMessages.status, ["pending", "failed"]),
        ),
      )
      .returning();
    return claimed
      ? { claimed, fresh }
      : { reason: "Ya enviado, en curso o resultado de Meta incierto" };
  });
  if (!claim.claimed || !claim.fresh) return { status: "skipped", reason: claim.reason };
  const { claimed, fresh } = claim;
  const key = `${fresh.id}:${kind}`;
  liveSends.add(key);
  const fence = and(
    eq(whatsappMessages.id, claimed.id),
    eq(whatsappMessages.status, "sending"),
    eq(whatsappMessages.attempts, claimed.attempts),
  );
  try {
    const metaMessageId = await sender(fresh, kind);
    await db
      .update(whatsappMessages)
      .set({ status: "sent", metaMessageId, sentAt: new Date(), error: null })
      .where(fence);
    return { status: "sent" };
  } catch (error) {
    const reason = errorMessage(error);
    // Network errors and lost responses may have been accepted by Meta; don't auto-retry.
    const definiteRejection = /^Meta rechazó la plantilla \(HTTP 4\d\d\)$/.test(reason);
    await db
      .update(whatsappMessages)
      .set({ status: definiteRejection ? "failed" : "unknown", error: reason })
      .where(fence);
    log.error("whatsapp.failed", { kind, code: booking.code, message: reason });
    return {
      status: "failed",
      reason: definiteRejection
        ? reason
        : "Resultado incierto; verificar en Meta antes de reintentar",
    };
  } finally {
    liveSends.delete(key);
  }
}

export async function sendReadyNotification(
  db: AppDb,
  bookingId: string,
  now: Date,
): Promise<NoticeResult> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  return booking
    ? sendNotice(db, booking, "ready", now)
    : { status: "skipped", reason: "Reserva inexistente" };
}

export async function listNotices(db: AppDb, bookingId: string) {
  const rows = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.bookingId, bookingId));
  return rows.map((row) => ({
    type: row.type,
    status: row.status,
    reason: row.error,
    attempts: row.attempts,
    metaMessageId: row.metaMessageId,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    reconciliationNote: row.reconciliationNote,
    canReconcile:
      row.status === "unknown" ||
      (row.status === "sending" &&
        row.claimedAt !== null &&
        Date.now() - row.claimedAt.getTime() > 120000),
  }));
}

/** Only an authenticated admin may call this after verifying the outcome with Meta. */
export async function reconcileNotice(
  db: AppDb,
  bookingId: string,
  kind: Kind,
  outcome: "sent" | "not_sent",
  evidence: string,
  metaMessageId: string | null,
  now: Date,
  workerStopped = false,
): Promise<boolean> {
  if (liveSends.has(`${bookingId}:${kind}`)) return false;
  if (evidence.trim().length < 10 || evidence.length > 1000) return false;
  if (outcome === "sent" && !metaMessageId?.match(/^wamid\.[A-Za-z0-9_+=/-]+$/)) return false;
  const [updated] = await db
    .update(whatsappMessages)
    .set({
      status: outcome === "sent" ? "sent" : "failed",
      metaMessageId: outcome === "sent" ? metaMessageId : null,
      sentAt: outcome === "sent" ? now : null,
      reconciledAt: now,
      reconciliationNote: `${outcome}: ${evidence.trim()}`,
      error: outcome === "not_sent" ? "Admin verificó que Meta no aceptó el mensaje" : null,
    })
    .where(
      and(
        eq(whatsappMessages.bookingId, bookingId),
        eq(whatsappMessages.type, kind),
        sql`(${whatsappMessages.status} = 'unknown' OR (${workerStopped} AND ${whatsappMessages.status} = 'sending' AND ${whatsappMessages.claimedAt} < ${new Date(now.getTime() - 120000)}))`,
      ),
    )
    .returning();
  return Boolean(updated);
}

export async function sendReminderNotification(
  db: AppDb,
  bookingId: string,
  now: Date,
): Promise<NoticeResult> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  return booking
    ? sendNotice(db, booking, "reminder", now)
    : { status: "skipped", reason: "Reserva inexistente" };
}

export async function sendPendingReminders(
  db: AppDb,
  now: Date,
  sender: Sender = sendTemplate,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const startedAt = Date.now();
  const deadline = DateTime.fromJSDate(now).setZone(TIMEZONE).plus({ hours: 24 }).toJSDate();
  const candidates = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "confirmed"),
        gt(bookings.startsAt, now),
        lte(bookings.startsAt, deadline),
      ),
    )
    .orderBy(asc(bookings.startsAt));
  const totals = { sent: 0, failed: 0, skipped: 0 };
  for (const booking of candidates) {
    const result = await sendNotice(
      db,
      booking,
      "reminder",
      new Date(now.getTime() + Date.now() - startedAt),
      sender,
    );
    totals[result.status] += 1;
  }
  return totals;
}
