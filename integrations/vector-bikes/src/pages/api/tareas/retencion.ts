import type { APIRoute } from "astro";
import { handleRetentionTask } from "../../../server/api/task-handlers.ts";
import { getDb } from "../../../server/db/client.ts";

export const prerender = false;

// El handler obtiene el almacenamiento con `getStorage()` recién después de validar el bearer.
export const POST: APIRoute = ({ request }) => handleRetentionTask(request, getDb(), new Date());
