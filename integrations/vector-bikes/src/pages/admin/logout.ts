import type { APIRoute } from "astro";
import { isAllowedOrigin } from "../../server/api/handlers.ts";
import { logoutAdmin, SESSION_COOKIE } from "../../server/auth/admin-auth.ts";
import { getDb } from "../../server/db/client.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!isAllowedOrigin(request)) {
    return new Response("No pudimos confirmar la solicitud.", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  await logoutAdmin(getDb(), cookies.get(SESSION_COOKIE)?.value, new Date());
  cookies.delete(SESSION_COOKIE, { path: "/" });
  return redirect("/admin/login", 303);
};
