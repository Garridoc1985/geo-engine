import type { APIRoute } from "astro";
import { getDb } from "../../../server/db/client.ts";
import { handleWhatsAppCron } from "../../../server/whatsapp/cron.ts";

export const prerender = false;
export const POST: APIRoute = ({ request }) => handleWhatsAppCron(request, getDb(), new Date());
