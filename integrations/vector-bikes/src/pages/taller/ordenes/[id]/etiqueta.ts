import type { APIRoute } from "astro";
import { z } from "zod";
import { getSiteEnv } from "../../../../lib/env.ts";
import { loginRedirect, requireAdmin, SESSION_COOKIE } from "../../../../server/auth/admin-auth.ts";
import { can, forbiddenResponse } from "../../../../server/auth/permissions.ts";
import { getDb } from "../../../../server/db/client.ts";
import { buildLabel } from "../../../../server/taller/label.ts";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, url }) => {
  const db = getDb();
  const actor = await requireAdmin(db, cookies.get(SESSION_COOKIE)?.value, new Date());
  if (!actor)
    return new Response(null, {
      status: 303,
      headers: {
        location: loginRedirect(url.pathname + url.search),
        "cache-control": "no-store",
      },
    });
  if (!can(actor.role, "orders.edit")) return forbiddenResponse();
  const id = z.uuid().safeParse(params.id);
  const result = id.success
    ? await buildLabel(db, actor, id.data, getSiteEnv().PUBLIC_SITE_URL)
    : ({ ok: false, code: "not_found" } as const);
  if (!result.ok) {
    if (result.code === "forbidden") return forbiddenResponse();
    return new Response("Orden no encontrada.", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  return new Response(result.html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};
