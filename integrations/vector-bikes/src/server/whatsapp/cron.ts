import { timingSafeEqual } from "node:crypto";
import { getCronEnv } from "../../lib/env.ts";
import type { AppDb } from "../db/client.ts";
import { sendPendingReminders } from "./service.ts";

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function handleWhatsAppCron(
  request: Request,
  db: AppDb,
  now: Date,
  secret: string | undefined = getCronEnv().CRON_SECRET,
): Promise<Response> {
  const headers = { "cache-control": "no-store", "content-type": "application/json" };
  if (request.method !== "POST")
    return new Response('{"error":"Método no permitido"}', { status: 405, headers });
  if (!authorized(request.headers.get("authorization"), secret)) {
    return new Response('{"error":"No autorizado"}', { status: 401, headers });
  }
  const summary = await sendPendingReminders(db, now);
  return new Response(JSON.stringify(summary), { status: 200, headers });
}
