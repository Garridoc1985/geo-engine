import type { APIRoute } from "astro";
import { clientIp } from "../../server/api/client-ip.ts";
import { handleCreateBooking } from "../../server/api/handlers.ts";
import { getDb } from "../../server/db/client.ts";
import { notifyBookingCreated } from "../../server/email/notifications.ts";

export const prerender = false;

export const POST: APIRoute = ({ request, clientAddress }) =>
  handleCreateBooking(request, {
    db: getDb(),
    now: new Date(),
    ip: clientIp(request, clientAddress),
    onCreated: notifyBookingCreated,
  });
