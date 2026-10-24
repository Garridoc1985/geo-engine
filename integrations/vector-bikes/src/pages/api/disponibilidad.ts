import type { APIRoute } from "astro";
import { clientIp } from "../../server/api/client-ip.ts";
import { handleAvailability } from "../../server/api/handlers.ts";
import { getDb } from "../../server/db/client.ts";

export const prerender = false;

export const GET: APIRoute = ({ url, request, clientAddress }) =>
  handleAvailability(url, {
    db: getDb(),
    now: new Date(),
    ip: clientIp(request, clientAddress),
  });
