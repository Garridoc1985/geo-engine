import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { orderPhotos, workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import {
  handleMediaRequest,
  handlePhotoUpload,
  listOrderPhotos,
  MAX_PHOTO_BYTES,
  photoKeys,
  uploadOrderPhoto,
} from "../../src/server/taller/photos.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-05T15:00:00.000Z");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let orderId: string;
let storage: ObjectStorage;
let dir: string;
let jpeg: Buffer;

async function createActor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      email: `${randomUUID()}@example.test`,
      name: "Personal de prueba",
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, email: user.email, name: user.name };
}

async function createOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Cliente de prueba", phoneE164: "+56912345678" })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer.id,
      brand: "Vector",
      model: "Prueba",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Revisión general",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

function request(
  bytes = jpeg,
  type = "image/jpeg",
  stage = "recepcion",
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  form.set("foto", new File([new Uint8Array(bytes)], "foto.jpg", { type }));
  form.set("etapa", stage);
  return new Request(`https://vectorbikes.cl/taller/ordenes/${orderId}/fotos`, {
    method: "POST",
    headers: { origin: "https://vectorbikes.cl", ...headers },
    body: form,
  });
}

function upload(req = request(), actor: SessionUser | null = owner, id = orderId) {
  return handlePhotoUpload(req, { db: test.db, storage, actor, orderId: id, now: NOW });
}

function storedFiles() {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
}

async function photoRow() {
  const [photo] = await test.db.select().from(orderPhotos);
  if (!photo) throw new Error("Falta la foto de prueba.");
  return photo;
}

async function expectEmpty() {
  expect(await test.db.select().from(orderPhotos)).toEqual([]);
  expect(storedFiles()).toEqual([]);
}

beforeEach(async () => {
  test = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "vector-photos-"));
  storage = createLocalStorage(dir);
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await createActor(branch.id, "owner");
  mechanic = await createActor(branch.id, "mechanic");
  orderId = await createOrder();
  jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#eeeeee" } })
    .jpeg()
    .toBuffer();
  return async () => {
    await test.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

it.each([
  ["recepcion", "reservada", "recepcion_6m"],
  ["terminado", "control_calidad", "permanente"],
])("1: guarda %s con retención %s", async (stage, status, retention) => {
  await test.db.update(workOrders).set({ status }).where(eq(workOrders.id, orderId));
  const response = await upload(request(jpeg, "image/jpeg", stage));
  expect(response.status).toBe(201);
  const photo = await photoRow();
  expect(await response.json()).toEqual({
    id: photo.id,
    thumbUrl: `/taller/media/${photo.thumbKey}`,
  });
  expect(photo).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    stage,
    retentionClass: retention,
    createdBy: owner.id,
    width: 800,
    height: 600,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(photoKeys(orderId, photo.id)).toEqual({
    fullKey: photo.fullKey,
    thumbKey: photo.thumbKey,
  });
  const full = await storage.get(photo.fullKey);
  const thumb = await storage.get(photo.thumbKey);
  expect(full).not.toBeNull();
  expect(thumb).not.toBeNull();
  expect((await sharp(full as Buffer).metadata()).format).toBe("jpeg");
  expect((await sharp(thumb as Buffer).metadata()).width).toBe(400);
  expect(storedFiles()).toHaveLength(2);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it.each([
  [413, "image/jpeg", true],
  [415, "text/plain", false],
  [415, "image/jpeg", false],
])("2: rechaza archivo con %i (%s)", async (status, type, large) => {
  const bytes = large ? Buffer.alloc(15 * 1024 * 1024 + 1) : Buffer.from("archivo inválido");
  expect((await upload(request(bytes, type))).status).toBe(status);
  await expectEmpty();
});

it("3: borra ambos objetos y relanza si la transacción rechaza", async () => {
  const failure = new Error("Falla de transacción de prueba");
  const db = new Proxy(test.db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return async () => {
          expect(storedFiles()).toHaveLength(2);
          throw failure;
        };
      return Reflect.get(target, property, receiver);
    },
  }) as AppDb;
  await expect(
    uploadOrderPhoto(db, storage, owner, { orderId, stage: "recepcion", bytes: jpeg }, NOW),
  ).rejects.toBe(failure);
  await expectEmpty();
});

it("4: sirve solo medios vigentes y accesibles, con cabeceras privadas", async () => {
  await upload();
  const photo = await photoRow();
  const response = await handleMediaRequest(test.db, storage, owner, photo.thumbKey);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toBe("private, max-age=300");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await storage.get(photo.thumbKey));
  for (const key of [
    "../foto.jpg",
    `${photo.thumbKey}\n`,
    photoKeys(orderId, randomUUID()).thumbKey,
  ]) {
    expect((await handleMediaRequest(test.db, storage, owner, key)).status).toBe(404);
  }
  expect((await handleMediaRequest(test.db, storage, null, "inválida")).status).toBe(401);
  await test.db.update(orderPhotos).set({ fullPurgedAt: NOW }).where(eq(orderPhotos.id, photo.id));
  expect((await handleMediaRequest(test.db, storage, owner, photo.fullKey)).status).toBe(404);
  expect((await listOrderPhotos(test.db, owner, orderId))[0]).toMatchObject({
    fullUrl: null,
    thumbUrl: `/taller/media/${photo.thumbKey}`,
  });
  await storage.delete(photo.thumbKey);
  expect((await handleMediaRequest(test.db, storage, owner, photo.thumbKey)).status).toBe(404);
  await test.db
    .update(orderPhotos)
    .set({ voidedAt: NOW, voidedBy: owner.id })
    .where(eq(orderPhotos.id, photo.id));
  expect(await listOrderPhotos(test.db, owner, orderId)).toEqual([]);
  expect((await handleMediaRequest(test.db, storage, owner, photo.thumbKey)).status).toBe(404);
});

it("5: mecánico no asignado no sube reparación ni accede a otra orden", async () => {
  await test.db
    .update(workOrders)
    .set({ status: "en_reparacion" })
    .where(eq(workOrders.id, orderId));
  expect((await upload(request(jpeg, "image/jpeg", "reparacion"), mechanic)).status).toBe(403);
  await expectEmpty();
  await upload(request(jpeg, "image/jpeg", "reparacion"));
  const photo = await photoRow();
  expect((await handleMediaRequest(test.db, storage, mechanic, photo.thumbKey)).status).toBe(403);
  expect(await listOrderPhotos(test.db, mechanic, orderId)).toEqual([]);
  await test.db
    .update(workOrders)
    .set({ assignedMechanicId: mechanic.id })
    .where(eq(workOrders.id, orderId));
  expect((await upload(request(jpeg, "image/jpeg", "reparacion"), mechanic)).status).toBe(201);
  expect((await handleMediaRequest(test.db, storage, mechanic, photo.thumbKey)).status).toBe(200);
});

it("permite al mecánico recepción sin asignar, pero no asignada a otro", async () => {
  expect((await upload(request(), mechanic)).status).toBe(201);
  await test.db
    .update(workOrders)
    .set({ assignedMechanicId: owner.id })
    .where(eq(workOrders.id, orderId));
  expect((await upload(request(), mechanic)).status).toBe(403);
});

it("prioriza sesión, Origin, longitud, formulario, tamaño y tipo", async () => {
  const badOrigin = request(jpeg, "image/jpeg", "recepcion", {
    origin: "https://otro.test",
    "content-length": String(17 * 1024 * 1024),
  });
  expect((await upload(badOrigin, null, "x")).status).toBe(401);
  expect((await upload(badOrigin, owner, "x")).status).toBe(403);
  expect(
    (
      await upload(
        request(jpeg, "image/jpeg", "recepcion", {
          "content-length": String(16 * 1024 * 1024 + 1),
        }),
        owner,
        "x",
      )
    ).status,
  ).toBe(413);
  expect((await upload(request(), owner, "x")).status).toBe(422);
  expect((await upload(request(jpeg, "image/jpeg", "otra"))).status).toBe(422);
  expect((await upload(request(Buffer.alloc(MAX_PHOTO_BYTES + 1), "text/plain"))).status).toBe(413);
  expect(
    (
      await upload(
        new Request("https://vectorbikes.cl", {
          method: "POST",
          headers: { origin: "https://vectorbikes.cl" },
          body: "malformado",
        }),
      )
    ).status,
  ).toBe(422);
  await expectEmpty();
});

it("ordena las etapas y rechaza un estado incompatible o sucursal ajena", async () => {
  expect((await upload(request(jpeg, "image/jpeg", "terminado"))).status).toBe(409);
  expect((await upload(request(), owner, randomUUID())).status).toBe(404);
  await upload();
  await test.db
    .update(workOrders)
    .set({ status: "control_calidad" })
    .where(eq(workOrders.id, orderId));
  await upload(request(jpeg, "image/jpeg", "terminado"));
  await upload(request(jpeg, "image/jpeg", "reparacion"));
  expect((await listOrderPhotos(test.db, owner, orderId)).map((photo) => photo.stage)).toEqual([
    "recepcion",
    "reparacion",
    "terminado",
  ]);
  const foreign = { ...owner, branchId: randomUUID() };
  expect((await upload(request(), foreign)).status).toBe(404);
  expect(await listOrderPhotos(test.db, foreign, orderId)).toEqual([]);
  expect(
    (await handleMediaRequest(test.db, storage, foreign, (await photoRow()).thumbKey)).status,
  ).toBe(404);
});

it("la base exige sucursal, claves únicas y retención correspondiente", async () => {
  await upload();
  const photo = await photoRow();
  await expect(
    test.db
      .update(orderPhotos)
      .set({ retentionClass: "permanente" })
      .where(eq(orderPhotos.id, photo.id)),
  ).rejects.toThrow();
  await expect(test.db.execute(sql`update order_photos set branch_id = null`)).rejects.toThrow();
  await expect(
    test.db.insert(orderPhotos).values({ ...photo, id: randomUUID() }),
  ).rejects.toThrow();
});
