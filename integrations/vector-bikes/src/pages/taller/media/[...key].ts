import type { APIRoute } from "astro";
import { requireAdmin, SESSION_COOKIE } from "../../../server/auth/admin-auth.ts";
import { getDb } from "../../../server/db/client.ts";
import { getStorage } from "../../../server/storage/storage.ts";
import { handleMediaRequest } from "../../../server/taller/photos.ts";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params }) => {
  const db = getDb();
  const actor = await requireAdmin(db, cookies.get(SESSION_COOKIE)?.value, new Date());
  return handleMediaRequest(db, await getStorage(), actor, params.key ?? "");
};
