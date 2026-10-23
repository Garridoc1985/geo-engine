import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { EnvError, getCronEnv, getTasksEnv } from "../../src/lib/env.ts";
import { handleRemindersTask, isAuthorizedTask } from "../../src/server/api/task-handlers.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { bookings } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-09-15T13:00:00.000Z");
const SECRET = "test-tasks-secret-0123456789abcdef0123";
const EMAIL = "diego@ejemplo.cl";
const PHONE = "+56911111111";

function taskRequest(header: string | null = `Bearer ${SECRET}`, method = "POST") {
  return new Request("https://vectorbikes.cl/api/tareas/recordatorios", {
    method,
    headers: header === null ? {} : { authorization: header },
  });
}

async function newBooking(db: AppDb) {
  const result = await createBooking(
    db,
    {
      mode: "taller",
      serviceDate: "2026-09-16",
      start: "15:00",
      customerName: "Diego Muñoz",
      phoneE164: PHONE,
      email: EMAIL,
      bike: "MTB Scott",
      description: "Purga de frenos",
      comuna: null,
      address: null,
      ipHash: null,
    },
    NOW,
  );
  if (!result.ok) throw new Error(`no se pudo crear la reserva: ${result.code}`);
  return result.booking;
}

describe("tarea de recordatorios", () => {
  let test: TestDb;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(async () => {
    vi.stubEnv("TASKS_SECRET", undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleOutbox.length = 0;
    test = await createTestDb();
    return () => test.close();
  });

  afterEach(() => {
    const lines = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    try {
      for (const sensitive of [EMAIL, PHONE, SECRET]) expect(lines).not.toContain(sensitive);
      expect(lines).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it.each([null, `Bearer ${"x".repeat(SECRET.length)}`, "Bearer incorrecto", `bearer ${SECRET}`])(
    "rechaza una cabecera inválida (%s) sin enviar",
    async (header) => {
      const send = vi.fn();
      const response = await handleRemindersTask(taskRequest(header), test.db, NOW, {
        secret: SECRET,
        send,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(send).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"tasks.unauthorized"'));
    },
  );

  it("rechaza la falta de secreto configurado sin enviar", async () => {
    const send = vi.fn();
    const response = await handleRemindersTask(taskRequest(), test.db, NOW, { send });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"tasks.not_configured"'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"tasks.unauthorized"'));
  });

  it("envía y marca la reserva de mañana una sola vez", async () => {
    const booking = await newBooking(test.db);
    vi.stubEnv("TASKS_SECRET", SECRET);
    const response = await handleRemindersTask(taskRequest(), test.db, NOW);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sent: 1 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [row] = await test.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.reminderSentAt).toEqual(NOW);
    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(EMAIL);

    const repeated = await handleRemindersTask(taskRequest(), test.db, NOW);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ok: true, sent: 0 });
    expect(consoleOutbox).toHaveLength(1);
  });

  it("responde 500 con el resumen de envíos fallidos", async () => {
    const send = vi.fn().mockResolvedValue({ sent: 1, failed: 2 });
    const response = await handleRemindersTask(taskRequest(), test.db, NOW, {
      secret: SECRET,
      send,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, sent: 1, failed: 2 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(send).toHaveBeenCalledExactlyOnceWith(test.db, NOW);
  });

  it("registra una excepción y responde 500", async () => {
    const send = vi.fn().mockRejectedValue(new Error("sin conexión"));
    const response = await handleRemindersTask(taskRequest(), test.db, NOW, {
      secret: SECRET,
      send,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal_error" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"tasks.reminders_failed"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"message":"sin conexión"'));
  });

  it("rechaza otro método antes de resolver el secreto", async () => {
    const send = vi.fn();
    const response = await handleRemindersTask(taskRequest(null, "GET"), test.db, NOW, { send });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ ok: false, error: "method_not_allowed" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(send).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("exige un secreto de al menos 32 caracteres y compara largos en bytes", () => {
    expect(isAuthorizedTask(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedTask("Bearer corto", "corto")).toBe(false);
    expect(isAuthorizedTask(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(isAuthorizedTask(`Bearer ${SECRET}`, "")).toBe(false);
    expect(isAuthorizedTask(`Bearer ${"é".repeat(SECRET.length)}`, SECRET)).toBe(false);
  });

  it("valida TASKS_SECRET y permite CRON_SECRET vacío o ausente", () => {
    expect(getTasksEnv({ TASKS_SECRET: SECRET })).toEqual({ TASKS_SECRET: SECRET });
    expect(() => getTasksEnv({})).toThrow(EnvError);
    expect(() => getTasksEnv({ TASKS_SECRET: "x".repeat(31) })).toThrow(EnvError);
    expect(getTasksEnv({ TASKS_SECRET: "x".repeat(32) }).TASKS_SECRET).toHaveLength(32);
    expect(getCronEnv({})).toEqual({});
    expect(getCronEnv({ CRON_SECRET: "" })).toEqual({ CRON_SECRET: "" });
    expect(getCronEnv({ CRON_SECRET: "corto" })).toEqual({ CRON_SECRET: "corto" });
  });
});
