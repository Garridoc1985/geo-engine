import type { APIRoute } from "astro";
import { handleRemindersTask } from "../../../server/api/task-handlers.ts";
import { getDb } from "../../../server/db/client.ts";

export const prerender = false;

export const POST: APIRoute = ({ request }) => handleRemindersTask(request, getDb(), new Date());
