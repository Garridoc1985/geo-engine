import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { getEmailEnv } from "../../src/lib/env.ts";
import { handleAlertsTask, handleRetentionTask } from "../../src/server/api/task-handlers.ts";
import { orderPhotos, workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { overdueOrders, sendOverdueDigest } from "../../src/server/taller/maintenance.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

// En Santiago aún es el 8 de octubre.
const NOW = new Date("2026-10-09T01:00:00.000Z");
const SECRET = "test-tasks-secret-0123456789abcdef0123";
const EMAIL = "cliente@ejemplo.cl";
const PHONE = "+56912345678";
const RUT = "12345678-5";
type Identity = { branchId: string; userId: string; customerId: string; bikeId: string };
let test: TestDb;
let identity: Identity;
let storage: ObjectStorage;
let dir: string;
let logSpy: MockInstance<typeof console.log>;
let errorSpy: MockInstance<typeof console.error>;

function taskRequest(task: string, header: string | null = `Bearer ${SECRET}`, method = "POST") {
  return new Request(`https://vectorbikes.cl/api/tareas/${task}`, {
    method,
    headers: header === null ? {} : { authorization: header },
  });
}

async function seedIdentity(name = "Diego Muñoz"): Promise<Identity> {
  const [branch] = await test.db
    .insert(branches)
    .values({ name: `Vitacura ${name}` })
    .returning();
  if (!branch) throw new Error("Falta la sucursal.");
  const [user] = await test.db
    .insert(users)
    .values({
      branchId: branch.id,
      role: "owner",
      name: "Dueño",
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
    })
    .returning();
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: branch.id,
      name,
      phoneE164: PHONE,
      email: EMAIL,
      rut: name === "Diego Muñoz" ? RUT : null,
    })
    .returning();
  if (!user || !customer) throw new Error("Falta el usuario o cliente.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: branch.id,
      customerId: customer.id,
      brand: "Scott",
      model: "Spark",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta.");
  return { branchId: branch.id, userId: user.id, customerId: customer.id, bikeId: bike.id };
}

async function seedOrder(
  number: number,
  date: string | null,
  status = "recibida",
  who = identity,
  voided = false,
) {
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: who.branchId,
      number,
      customerId: who.customerId,
      bikeId: who.bikeId,
      requestedService: "Revisión general",
      createdBy: who.userId,
      estimatedDeliveryDate: date,
      status,
      qcApprovedAt: status === "entregada" ? NOW : null,
      voidedAt: voided ? NOW : null,
      voidedBy: voided ? who.userId : null,
    })
    .returning();
  if (!order) throw new Error("Falta la orden.");
  return order;
}

async function seedPhoto(
  orderId: string,
  months: number,
  stage: "recepcion" | "terminado" = "recepcion",
) {
  const id = randomUUID();
  const createdAt = DateTime.fromJSDate(NOW)
    .setZone("America/Santiago")
    .minus({ months })
    .toJSDate();
  const fullKey = `orders/${orderId}/${id}-full.jpg`;
  const thumbKey = `orders/${orderId}/${id}-thumb.jpg`;
  await storage.put(fullKey, Buffer.from("completa"), "image/jpeg");
  await storage.put(thumbKey, Buffer.from("miniatura"), "image/jpeg");
  const [photo] = await test.db
    .insert(orderPhotos)
    .values({
      id,
      branchId: identity.branchId,
      workOrderId: orderId,
      stage,
      retentionClass: stage === "recepcion" ? "recepcion_6m" : "permanente",
      fullKey,
      thumbKey,
      width: 800,
      height: 600,
      createdBy: identity.userId,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  if (!photo) throw new Error("Falta la foto.");
  return photo;
}

function alerts(header: string | null = `Bearer ${SECRET}`, method = "POST") {
  return handleAlertsTask(taskRequest("alertas", header, method), test.db, NOW, { secret: SECRET });
}

function retention(target = storage) {
  return handleRetentionTask(taskRequest("retencion"), test.db, NOW, {
    secret: SECRET,
    storage: target,
  });
}

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TASKS_SECRET", undefined);
  consoleOutbox.length = 0;
  test = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "vector-maintenance-"));
  storage = createLocalStorage(dir);
  identity = await seedIdentity();
  return async () => {
    await test.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

afterEach(() => {
  const lines = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
  try {
    for (const sensitive of [EMAIL, PHONE, RUT, SECRET, "Diego Muñoz"]) {
      expect(lines).not.toContain(sensitive);
    }
    expect(lines).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.each(["alertas", "retencion"])("%s rechaza bearer ausente o incorrecto", async (task) => {
  const transport = { send: vi.fn() };
  const deleteSpy = vi.spyOn(storage, "delete");
  for (const header of [null, `Bearer ${"x".repeat(SECRET.length)}`]) {
    const handler = task === "alertas" ? handleAlertsTask : handleRetentionTask;
    const response = await handler(taskRequest(task, header), test.db, NOW, {
      secret: SECRET,
      transport,
      storage,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(transport.send).not.toHaveBeenCalled();
  expect(deleteSpy).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"tasks.unauthorized"'));
});

it.each(["alertas", "retencion"])(
  "%s rechaza otro método antes de resolver el secreto",
  async (task) => {
    const handler = task === "alertas" ? handleAlertsTask : handleRetentionTask;
    const response = await handler(taskRequest(task, null, "GET"), test.db, NOW);
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ ok: false, error: "method_not_allowed" });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  },
);

it.each(["alertas", "retencion"])("%s rechaza secreto no configurado", async (task) => {
  const handler = task === "alertas" ? handleAlertsTask : handleRetentionTask;
  const response = await handler(taskRequest(task), test.db, NOW);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"tasks.not_configured"'));
});

it("envía el resumen exacto de dos atrasadas y omite entregadas", async () => {
  await seedOrder(2, "2026-10-07");
  const other = await seedIdentity("Ana Pérez");
  await seedOrder(1, "2026-10-06", "en_reparacion", other);
  await seedOrder(3, "2026-10-01", "entregada");
  vi.stubEnv("TASKS_SECRET", SECRET);
  const response = await handleAlertsTask(taskRequest("alertas"), test.db, NOW);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, overdue: 2, sent: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(consoleOutbox).toHaveLength(1);
  const message = consoleOutbox[0];
  expect(message?.to).toBe(getEmailEnv().SHOP_NOTIFY_EMAIL);
  expect(message?.subject).toBe("Órdenes atrasadas: 2 · Vector Bikes");
  expect(message?.text).toBe(
    [
      "OT-00001 · Ana Pérez · Scott Spark · prometida 06-10-2026 (2 días)",
      "OT-00002 · Diego Muñoz · Scott Spark · prometida 07-10-2026 (1 días)",
    ].join("\n"),
  );
  for (const sensitive of [EMAIL, PHONE, RUT, "OT-00003", "Vitacura"]) {
    expect(`${message?.text}${message?.html}`).not.toContain(sensitive);
  }
  expect(await (await alerts()).json()).toEqual({ ok: true, overdue: 2, sent: true });
  expect(consoleOutbox).toHaveLength(2);
});

it("sin atrasadas no envía ni siquiera si el transporte fallaría", async () => {
  await seedOrder(1, "2026-10-08");
  await seedOrder(2, "2026-10-09");
  await seedOrder(3, null);
  await seedOrder(4, "2026-10-01", "cancelada");
  await seedOrder(5, "2026-10-01", "trabajo_rechazado");
  await seedOrder(6, "2026-10-01", "recibida", identity, true);
  const transport = { send: vi.fn().mockRejectedValue(new Error("sin envío")) };
  expect(await sendOverdueDigest(test.db, NOW, { transport })).toEqual({ overdue: 0, sent: false });
  const response = await alerts();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, overdue: 0, sent: false });
  expect(transport.send).not.toHaveBeenCalled();
  expect(consoleOutbox).toHaveLength(0);
});

it("ordena por fecha y número y cuenta días locales al cruzar horario de verano", async () => {
  await seedOrder(2, "2026-09-04");
  await seedOrder(1, "2026-09-04");
  expect(await overdueOrders(test.db, NOW)).toEqual(
    [1, 2].map((number) => ({
      number: `OT-0000${number}`,
      customerName: "Diego Muñoz",
      bike: "Scott Spark",
      estimatedDeliveryDate: "2026-09-04",
      daysLate: 34,
    })),
  );
});

it("el envío fallido propaga y responde 500 con el conteo sin datos personales en logs", async () => {
  await seedOrder(1, "2026-10-07");
  await seedOrder(2, "2026-10-06");
  const failure = new Error(`${EMAIL} ${PHONE} ${RUT} ${SECRET}`);
  const transport = { send: vi.fn().mockRejectedValue(failure) };
  await expect(sendOverdueDigest(test.db, NOW, { transport })).rejects.toMatchObject({
    overdue: 2,
    cause: failure,
  });
  const response = await handleAlertsTask(taskRequest("alertas"), test.db, NOW, {
    secret: SECRET,
    transport,
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ ok: false, overdue: 2, sent: false });
  expect(consoleOutbox).toHaveLength(0);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"tasks.alerts_failed"'));
});

it("escapa nombres y bicicletas en el HTML del correo", async () => {
  await test.db
    .update(customers)
    .set({ name: "Ana <script>&" })
    .where(eq(customers.id, identity.customerId));
  await test.db.update(bikes).set({ model: 'Spark "<b>"' }).where(eq(bikes.id, identity.bikeId));
  await seedOrder(1, "2026-10-07");
  await alerts();
  expect(consoleOutbox[0]?.html).toContain("Ana &lt;script&gt;&amp;");
  expect(consoleOutbox[0]?.html).toContain("Spark &quot;&lt;b&gt;&quot;");
  expect(consoleOutbox[0]?.text).toContain("Ana <script>&");
});

it("purga solo la completa de recepción antigua, conserva filas y miniaturas y es idempotente", async () => {
  const order = await seedOrder(1, null);
  const old = await seedPhoto(order.id, 7);
  const recent = await seedPhoto(order.id, 1);
  const finished = await seedPhoto(order.id, 7, "terminado");
  const boundary = await seedPhoto(order.id, 6);
  const deleteSpy = vi.spyOn(storage, "delete");
  const transactionSpy = vi.spyOn(test.db, "transaction");
  const response = await retention();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, purged: 1 });
  expect(deleteSpy).toHaveBeenCalledExactlyOnceWith(old.fullKey);
  expect(transactionSpy).not.toHaveBeenCalled();
  expect(await storage.exists(old.fullKey)).toBe(false);
  for (const photo of [old, recent, finished, boundary]) {
    expect(await storage.exists(photo.thumbKey)).toBe(true);
    if (photo !== old) expect(await storage.exists(photo.fullKey)).toBe(true);
  }
  const rows = await test.db.select().from(orderPhotos);
  expect(rows).toHaveLength(4);
  expect(rows.find((row) => row.id === old.id)).toMatchObject({
    fullPurgedAt: NOW,
    updatedAt: NOW,
  });
  expect(rows.filter((row) => row.id !== old.id).every((row) => row.fullPurgedAt === null)).toBe(
    true,
  );
  expect(await (await retention()).json()).toEqual({ ok: true, purged: 0 });
  expect(deleteSpy).toHaveBeenCalledTimes(1);
});

it("un fallo al borrar no marca la fila, sigue con otras fotos y permite reintento", async () => {
  const order = await seedOrder(1, null);
  const failed = await seedPhoto(order.id, 7);
  const good = await seedPhoto(order.id, 7);
  const target = {
    ...storage,
    delete: vi.fn(async (key: string) => {
      if (key === failed.fullKey) throw new Error(`${EMAIL} ${PHONE} ${SECRET}`);
      await storage.delete(key);
    }),
  };
  const response = await retention(target);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ ok: false, purged: 1, failed: 1 });
  const rows = await test.db.select().from(orderPhotos);
  expect(rows.find((row) => row.id === failed.id)?.fullPurgedAt).toBeNull();
  expect(rows.find((row) => row.id === good.id)?.fullPurgedAt).toEqual(NOW);
  expect(await storage.exists(failed.fullKey)).toBe(true);
  expect(await storage.exists(failed.thumbKey)).toBe(true);
  expect(await storage.exists(good.thumbKey)).toBe(true);
  expect(await storage.exists(good.fullKey)).toBe(false);
  expect(await (await retention()).json()).toEqual({ ok: true, purged: 1 });
});

it("una única eliminación fallida responde failed:1 sin marcar", async () => {
  const order = await seedOrder(1, null);
  const photo = await seedPhoto(order.id, 7);
  const target = { ...storage, delete: vi.fn().mockRejectedValue(new Error("sin almacenamiento")) };
  const response = await retention(target);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ ok: false, purged: 0, failed: 1 });
  const [row] = await test.db.select().from(orderPhotos).where(eq(orderPhotos.id, photo.id));
  expect(row?.fullPurgedAt).toBeNull();
  expect(row?.updatedAt).toEqual(photo.updatedAt);
  expect(await storage.exists(photo.fullKey)).toBe(true);
  expect(await storage.exists(photo.thumbKey)).toBe(true);
});

it("si la copia completa ya no existe y el borrado falla (como en Replit), la marca igual", async () => {
  const order = await seedOrder(1, null);
  const photo = await seedPhoto(order.id, 7);
  await storage.delete(photo.fullKey);
  const replitLike = {
    ...storage,
    delete: vi.fn(async (key: string) => {
      if (!(await storage.exists(key))) throw new Error("Object not found");
      await storage.delete(key);
    }),
  };
  const response = await retention(replitLike);
  expect(await response.json()).toEqual({ ok: true, purged: 1 });
  const [row] = await test.db.select().from(orderPhotos).where(eq(orderPhotos.id, photo.id));
  expect(row?.fullPurgedAt).toEqual(NOW);
  expect(await storage.exists(photo.thumbKey)).toBe(true);
});
