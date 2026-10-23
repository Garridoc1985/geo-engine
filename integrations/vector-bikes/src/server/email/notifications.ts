import { createEvent } from "ics";
import { type EmailEnv, getEmailEnv, getSiteEnv } from "../../lib/env.ts";
import { errorMessage, log } from "../../lib/log.ts";
import { SITE } from "../../lib/site.ts";
import type { Booking } from "../db/schema.ts";
import {
  type RenderedEmail,
  bookingRescheduledEmail,
  customerConfirmationEmail,
  shopCancellationEmail,
  shopNewBookingEmail,
  shopRescheduledEmail,
} from "./templates.ts";
import { type EmailMessage, type EmailTransport, createTransport } from "./transport.ts";

export type NotifyDeps = {
  env?: EmailEnv;
  transport?: EmailTransport;
  siteUrl?: string;
};

export const ICS_FILENAME = "reserva-vector-bikes.ics";

/**
 * El `.ics` original sale con `SEQUENCE: 0`. Para que el calendario mueva el evento en vez de
 * duplicarlo, cada reprogramación manda un número mayor: segundos desde una fecha fija, que crece
 * con el reloj y cabe de sobra en un entero de 32 bits. Dos reprogramaciones dentro del mismo
 * segundo compartirían el número, que es lo más cerca que se llega sin agregar una columna.
 */
const ICS_SEQUENCE_EPOCH_SECONDS = Date.UTC(2026, 0, 1) / 1000;

export function icsSequence(updatedAt: Date): number {
  return Math.max(1, Math.floor(updatedAt.getTime() / 1000 - ICS_SEQUENCE_EPOCH_SECONDS));
}

/** Evento de calendario en UTC; el cliente de correo lo muestra en la zona del usuario. */
export function buildIcs(booking: Booking, sequence = 0): string {
  const { error, value } = createEvent({
    uid: `${booking.code}@vectorbikes.cl`,
    sequence,
    productId: "vectorbikes/reservas",
    title: `${SITE.name} · Reserva ${booking.code}`,
    description: `Reserva ${booking.code}. Bicicleta: ${booking.bike}.`,
    location:
      booking.mode === "retiro"
        ? `${booking.address ?? ""}, ${booking.comuna ?? ""}`
        : `${SITE.streetAddress}, ${SITE.locality}`,
    start: booking.startsAt.getTime(),
    startInputType: "utc",
    startOutputType: "utc",
    end: booking.endsAt.getTime(),
    endInputType: "utc",
    endOutputType: "utc",
    status: "CONFIRMED",
    busyStatus: "BUSY",
  });
  if (error || !value) {
    throw error ?? new Error("No se pudo generar el archivo de calendario.");
  }
  return value;
}

export function cancelUrlFor(cancelToken: string, siteUrl: string): string {
  const url = new URL("/reservas/cancelar", siteUrl);
  url.searchParams.set("token", cancelToken);
  return url.toString();
}

function message(to: string, email: RenderedEmail): EmailMessage {
  return { to, subject: email.subject, html: email.html, text: email.text };
}

/** Un correo que falla se registra y no impide enviar los demás. */
async function deliver(
  transport: EmailTransport,
  kind: string,
  code: string,
  outgoing: EmailMessage,
): Promise<void> {
  try {
    await transport.send(outgoing);
  } catch (error) {
    log.error("email.failed", { kind, code, message: errorMessage(error) });
  }
}

/** Post-commit: confirmación al cliente (con .ics y enlace de cancelación) y aviso al taller. */
export async function notifyBookingCreated(
  booking: Booking,
  cancelToken: string,
  deps: NotifyDeps = {},
): Promise<void> {
  const env = deps.env ?? getEmailEnv();
  const transport = deps.transport ?? createTransport(env);
  const siteUrl = deps.siteUrl ?? getSiteEnv().PUBLIC_SITE_URL;

  if (booking.email !== null) {
    const confirmation = message(
      booking.email,
      customerConfirmationEmail(booking, cancelUrlFor(cancelToken, siteUrl)),
    );
    confirmation.attachments = [
      { filename: ICS_FILENAME, content: buildIcs(booking), contentType: "text/calendar" },
    ];
    await deliver(transport, "confirmation", booking.code, confirmation);
  }
  await deliver(
    transport,
    "shop_new_booking",
    booking.code,
    message(env.SHOP_NOTIFY_EMAIL, shopNewBookingEmail(booking)),
  );
}

/** Post-commit: aviso al taller de una cancelación. */
export async function notifyBookingCancelled(
  booking: Booking,
  deps: NotifyDeps = {},
): Promise<void> {
  const env = deps.env ?? getEmailEnv();
  const transport = deps.transport ?? createTransport(env);
  await deliver(
    transport,
    "shop_cancellation",
    booking.code,
    message(env.SHOP_NOTIFY_EMAIL, shopCancellationEmail(booking)),
  );
}

/** Post-commit: cambio al cliente (con calendario actualizado) y aviso al taller. */
export async function notifyBookingRescheduled(
  booking: Booking,
  previous: { serviceDate: string; start: string },
  deps: NotifyDeps = {},
): Promise<void> {
  const env = deps.env ?? getEmailEnv();
  const transport = deps.transport ?? createTransport(env);
  if (booking.email !== null) {
    const rescheduled = message(booking.email, bookingRescheduledEmail(booking, previous));
    rescheduled.attachments = [
      {
        filename: ICS_FILENAME,
        content: buildIcs(booking, icsSequence(booking.updatedAt)),
        contentType: "text/calendar",
      },
    ];
    await deliver(transport, "rescheduled", booking.code, rescheduled);
  }
  await deliver(
    transport,
    "shop_rescheduled",
    booking.code,
    message(env.SHOP_NOTIFY_EMAIL, shopRescheduledEmail(booking, previous)),
  );
}
