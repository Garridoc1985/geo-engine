import type { APIRoute } from "astro";
import { handleAlertsTask } from "../../../server/api/task-handlers.ts";
import { getDb } from "../../../server/db/client.ts";

export const prerender = false;

export const POST: APIRoute = ({ request }) => handleAlertsTask(request, getDb(), new Date());
