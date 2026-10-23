import type { APIRoute } from "astro";
import { getDb, pingDb } from "../../server/db/client.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  let db = false;
  try {
    db = await pingDb(getDb());
  } catch {
    db = false;
  }
  return new Response(JSON.stringify({ ok: db, db }), {
    status: db ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};
