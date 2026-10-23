import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { orderPhotos, workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { generateReport, viewReportByToken } from "../../src/server/taller/reports.ts";
import { newShareToken } from "../../src/server/taller/share-tokens.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-09T15:00:00Z");
const INPUT = { recommendations: "Lubricar la cadena", nextChecks: "Revisar en seis meses" };
const PRIVATE = { phoneE164: "+56912345678", email: "ana@example.test", rut: "12.345.678-5" };
let test: TestDb;
let owner: SessionUser;
let orderId: string;
let token: string;
let storage: ObjectStorage;
let thumbnail: Buffer;
let photos: (typeof orderPhotos.$inferSelect)[];

async function seedOwner() {
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta sucursal");
  const [user] = await test.db
    .insert(users)
    .values({
      branchId: branch.id,
      role: "owner",
      name: "Dueño",
      email: "owner@example.test",
      passwordHash: "hash",
    })
    .returning();
  if (!user) throw new Error("Falta usuario");
  owner = { id: user.id, branchId: branch.id, role: "owner", name: user.name, email: user.email };
}

async function seedOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: owner.branchId,
      name: " Ana María Pérez ",
      ...PRIVATE,
    })
    .returning();
  if (!customer) throw new Error("Falta cliente");
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId: customer.id,
      brand: "Trek",
      model: "Marlin",
      bikeType: "mtb",
    })
    .returning();
  if (!bike) throw new Error("Falta bicicleta");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      status: "lista_para_retirar",
      requestedService: "Mantención",
      diagnosis: "Cadena desgastada",
      qcApprovedAt: NOW,
      receivedAt: NOW,
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta orden");
  orderId = order.id;
}

async function seedPhotos() {
  thumbnail = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();
  photos = [];
  for (const stage of ["recepcion", "terminado"] as const) {
    const id = randomUUID();
    const fullKey = `orders/${orderId}/${id}-full.jpg`;
    const thumbKey = `orders/${orderId}/${id}-thumb.jpg`;
    await storage.put(fullKey, thumbnail, "image/jpeg");
    await storage.put(thumbKey, thumbnail, "image/jpeg");
    const [photo] = await test.db
      .insert(orderPhotos)
      .values({
        id,
        branchId: owner.branchId,
        workOrderId: orderId,
        stage,
        retentionClass: stage === "recepcion" ? "recepcion_6m" : "permanente",
        fullKey,
        thumbKey,
        width: 2,
        height: 2,
        createdBy: owner.id,
      })
      .returning();
    if (!photo) throw new Error("Falta foto");
    photos.push(photo);
  }
}

async function generate(input = INPUT) {
  const result = await generateReport(test.db, owner, orderId, input, NOW);
  if (!result.ok) throw new Error(result.code);
  return result.token;
}

beforeEach(async () => {
  test = await createTestDb();
  const dir = await mkdtemp(join(tmpdir(), "vector-report-view-"));
  storage = createLocalStorage(dir);
  await seedOwner();
  await seedOrder();
  await seedPhotos();
  token = await generate();
  return async () => {
    vi.restoreAllMocks();
    await test.close();
    await rm(dir, { recursive: true, force: true });
  };
});

it("1: devuelve el snapshot guardado y miniaturas JPEG de antes y después", async () => {
  await test.db
    .update(workOrders)
    .set({ diagnosis: "Diagnóstico modificado" })
    .where(eq(workOrders.id, orderId));
  const result = await viewReportByToken(test.db, storage, token);
  expect(result?.snapshot).toMatchObject({
    version: 1,
    orderNumber: "OT-00001",
    customerFirstName: "Ana",
    diagnosis: "Cadena desgastada",
    ...INPUT,
  });
  expect(result?.snapshot.photosBefore).toEqual([
    { photoId: photos[0]?.id, thumbKey: photos[0]?.thumbKey },
  ]);
  expect(result?.snapshot.photosAfter).toEqual([
    { photoId: photos[1]?.id, thumbKey: photos[1]?.thumbKey },
  ]);
  expect(Object.keys(result?.photos ?? {})).toHaveLength(2);
  for (const photo of photos) {
    const url = result?.photos[photo.id];
    expect(url).toBe(`data:image/jpeg;base64,${thumbnail.toString("base64")}`);
  }
});

it("2: regenerar invalida el token anterior y permite el nuevo", async () => {
  const current = await generate({ ...INPUT, recommendations: "Nueva recomendación" });
  expect(current).not.toBe(token);
  expect(await viewReportByToken(test.db, storage, token)).toBeNull();
  expect((await viewReportByToken(test.db, storage, current))?.snapshot.recommendations).toBe(
    "Nueva recomendación",
  );
});

it("2: un token bien formado inexistente devuelve null sin leer almacenamiento", async () => {
  const get = vi.spyOn(storage, "get");
  expect(await viewReportByToken(test.db, storage, newShareToken())).toBeNull();
  expect(get).not.toHaveBeenCalled();
});

it("2: tokens malformados devuelven null sin ninguna consulta", async () => {
  const select = vi.spyOn(test.db, "select");
  const get = vi.spyOn(storage, "get");
  for (const value of ["", "invalido", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`])
    expect(await viewReportByToken(test.db, storage, value)).toBeNull();
  expect(select).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("3: la purga de la copia completa de recepción conserva la miniatura", async () => {
  const before = photos[0];
  if (!before) throw new Error("Falta foto de recepción");
  await test.db.update(orderPhotos).set({ fullPurgedAt: NOW }).where(eq(orderPhotos.id, before.id));
  await storage.delete(before.fullKey);
  expect(await storage.exists(before.fullKey)).toBe(false);
  expect(await storage.exists(before.thumbKey)).toBe(true);
  const result = await viewReportByToken(test.db, storage, token);
  expect(result?.photos[before.id]).toBe(`data:image/jpeg;base64,${thumbnail.toString("base64")}`);
});

it("4: la vista pública incluye solo el primer nombre, sin teléfono, correo ni RUT", async () => {
  const result = await viewReportByToken(test.db, storage, token);
  expect(result?.snapshot.customerFirstName).toBe("Ana");
  for (const secret of [...Object.values(PRIVATE), "María", "Pérez", token])
    expect(JSON.stringify(result)).not.toContain(secret);
});
