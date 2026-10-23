import type { APIRoute } from "astro";
import { requireAdmin, SESSION_COOKIE } from "../../../../server/auth/admin-auth.ts";
import { getDb } from "../../../../server/db/client.ts";
import { getStorage } from "../../../../server/storage/storage.ts";
import { handlePhotoUpload } from "../../../../server/taller/photos.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, params }) => {
  const db = getDb();
  const now = new Date();
  const actor = await requireAdmin(db, cookies.get(SESSION_COOKIE)?.value, now);
  return handlePhotoUpload(request, {
    db,
    storage: await getStorage(),
    actor,
    orderId: params.id ?? "",
    now,
  });
};
