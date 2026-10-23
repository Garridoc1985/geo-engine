import { timingSafeEqual } from "node:crypto";
import { getTasksEnv } from "../../lib/env.ts";
import { errorMessage, log } from "../../lib/log.ts";
import type { AppDb } from "../db/client.ts";
import { sendReminders } from "../email/reminders.ts";
import type { EmailTransport } from "../email/transport.ts";
import { getStorage } from "../storage/storage.ts";
import type { ObjectStorage } from "../storage/storage.ts";
import {
  OverdueDigestError,
  purgeReceptionPhotos,
  sendOverdueDigest,
} from "../taller/maintenance.ts";
import { jsonResponse } from "./handlers.ts";

export function isAuthorizedTask(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function taskGuard(request: Request, task: string, suppliedSecret?: string): Response | null {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }
  let secret: string | undefined;
  try {
    secret = suppliedSecret ?? getTasksEnv().TASKS_SECRET;
  } catch {
    log.error("tasks.not_configured", { task });
  }
  if (!isAuthorizedTask(request.headers.get("authorization"), secret)) {
    log.warn("tasks.unauthorized", { task });
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }
  return null;
}

export async function handleRemindersTask(
  request: Request,
  db: AppDb,
  now: Date,
  deps: { secret?: string; send?: typeof sendReminders } = {},
): Promise<Response> {
  const rejected = taskGuard(request, "reminders", deps.secret);
  if (rejected) return rejected;
  try {
    const { sent, failed } = await (deps.send ?? sendReminders)(db, now);
    return failed === 0
      ? jsonResponse(200, { ok: true, sent })
      : jsonResponse(500, { ok: false, sent, failed });
  } catch (error) {
    log.error("tasks.reminders_failed", { message: errorMessage(error) });
    return jsonResponse(500, { ok: false, error: "internal_error" });
  }
}

export async function handleAlertsTask(
  request: Request,
  db: AppDb,
  now: Date,
  deps: { secret?: string; transport?: EmailTransport } = {},
): Promise<Response> {
  const rejected = taskGuard(request, "alerts", deps.secret);
  if (rejected) return rejected;
  try {
    const result = await sendOverdueDigest(db, now, deps);
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    const overdue = error instanceof OverdueDigestError ? error.overdue : 0;
    log.error("tasks.alerts_failed", { overdue });
    return jsonResponse(500, { ok: false, overdue, sent: false });
  }
}

export async function handleRetentionTask(
  request: Request,
  db: AppDb,
  now: Date,
  deps: { secret?: string; storage?: ObjectStorage } = {},
): Promise<Response> {
  const rejected = taskGuard(request, "retention", deps.secret);
  if (rejected) return rejected;
  try {
    const { purged, failed } = await purgeReceptionPhotos(
      db,
      deps.storage ?? (await getStorage()),
      now,
    );
    return failed === 0
      ? jsonResponse(200, { ok: true, purged })
      : jsonResponse(500, { ok: false, purged, failed });
  } catch {
    log.error("tasks.retention_failed");
    return jsonResponse(500, { ok: false, purged: 0, failed: 1 });
  }
}
