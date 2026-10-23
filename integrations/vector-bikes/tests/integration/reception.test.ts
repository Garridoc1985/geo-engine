import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import {
  intakeChecks,
  orderPhotos,
  orderSignatures,
  workOrders,
  workOrderStatusHistory,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { handleMediaRequest } from "../../src/server/taller/photos.ts";
import {
  decodeSignature,
  finalizeReception,
  insertSignatureRow,
  MAX_SIGNATURE_BYTES,
  receptionReadiness,
} from "../../src/server/taller/reception.ts";
import { INTAKE_CHECK_KEYS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const SIGNER = "Cliente de prueba";
const NOW = new Date("2026-10-05T15:00:00.000Z");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let orderId: string;
let storage: ObjectStorage;
let dir: string;
let png: Buffer;
let dataUrl: string;

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
    .values({
      branchId: owner.branchId,
      name: "Cliente de prueba",
      phoneE164: "+56912345678",
    })
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

async function updateOrder(values: Partial<typeof workOrders.$inferInsert>) {
  await test.db.update(workOrders).set(values).where(eq(workOrders.id, orderId));
}

async function ready(skip?: string) {
  if (skip !== "checklist")
    await test.db.insert(intakeChecks).values(
      INTAKE_CHECK_KEYS.map((itemKey) => ({
        branchId: owner.branchId,
        workOrderId: orderId,
        itemKey,
        result: "ok",
        createdBy: owner.id,
      })),
    );
  await test.db.insert(orderPhotos).values({
    branchId: owner.branchId,
    workOrderId: orderId,
    stage: "recepcion",
    retentionClass: "recepcion_6m",
    fullKey: `orders/${orderId}/${randomUUID()}-full.jpg`,
    thumbKey: `orders/${orderId}/${randomUUID()}-thumb.jpg`,
    width: 10,
    height: 10,
    createdBy: owner.id,
    voidedAt: skip === "fotos" ? NOW : null,
  });
  if (skip !== "fecha")
    await updateOrder({
      estimatedDeliveryDate: "2026-10-06",
      deliveryDateConfirmedAt: NOW,
    });
}

function finalize(signatureDataUrl = dataUrl, actor = owner, db = test.db, signedByName = SIGNER) {
  return finalizeReception(db, storage, actor, { orderId, signatureDataUrl, signedByName }, NOW);
}

function storedFiles() {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
}

async function expectUnchanged() {
  expect(await test.db.select().from(orderSignatures)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  expect(order).toMatchObject({ status: "reservada", receivedAt: null });
  expect(storedFiles()).toEqual([]);
}

async function existingSignature(kind: "recepcion" | "entrega" = "recepcion") {
  return insertSignatureRow(
    test.db,
    owner,
    {
      orderId,
      kind,
      storageKey: `orders/${orderId}/signature-${kind}-${randomUUID()}.png`,
      signedByName: "Cliente de prueba",
    },
    NOW,
  );
}

beforeEach(async () => {
  test = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "vector-reception-"));
  storage = createLocalStorage(dir);
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await createActor(branch.id, "owner");
  mechanic = await createActor(branch.id, "mechanic");
  orderId = await createOrder();
  png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#000000" } })
    .png()
    .toBuffer();
  dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  return async () => {
    vi.restoreAllMocks();
    await test.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

it("1: informa todos los faltantes en orden y conserva reservada", async () => {
  const missing = ["checklist", "fotos", "fecha", "firma"];
  expect(await receptionReadiness(test.db, orderId)).toEqual(missing);
  expect(await finalize("")).toEqual({
    ok: false,
    code: "incomplete",
    missing,
  });
  expect(await finalize("inválida")).toEqual({
    ok: false,
    code: "incomplete",
    missing: ["checklist", "fotos", "fecha"],
  });
  await expectUnchanged();
});

it.each(["checklist", "fotos", "fecha", "firma"])(
  "1: identifica el faltante %s",
  async (missing) => {
    await ready(missing);
    expect(await finalize(missing === "firma" ? "" : dataUrl)).toEqual({
      ok: false,
      code: "incomplete",
      missing: [missing],
    });
    await expectUnchanged();
  },
);

it("2: guarda PNG, firma, estado, historial y auditoría sin nombre ni texto libre", async () => {
  await ready();
  const put = vi.spyOn(storage, "put");
  expect(await finalize()).toEqual({ ok: true });
  const [signature] = await test.db.select().from(orderSignatures);
  expect(signature).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    kind: "recepcion",
    signedByName: "Cliente de prueba",
    signedAt: NOW,
    createdBy: owner.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (!signature) throw new Error("Falta la firma.");
  expect(signature.storageKey).toMatch(
    new RegExp(`^orders/${orderId}/signature-recepcion-[0-9a-f-]{36}\\.png$`),
  );
  expect(put).toHaveBeenCalledExactlyOnceWith(signature.storageKey, png, "image/png");
  expect(await storage.get(signature.storageKey)).toEqual(png);
  const [order] = await test.db.select().from(workOrders).where(eq(workOrders.id, orderId));
  expect(order).toMatchObject({ status: "recibida", receivedAt: NOW, updatedAt: NOW });
  const history = await test.db.select().from(workOrderStatusHistory);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    fromStatus: "reservada",
    toStatus: "recibida",
    actorUserId: owner.id,
    note: null,
    createdAt: NOW,
  });
  const audit = await test.db.select().from(auditLog);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "order.status_changed",
    entity: "work_order",
    entityId: orderId,
    branchId: owner.branchId,
    actorUserId: owner.id,
    createdAt: NOW,
  });
  expect(audit[0]?.details).toEqual({ from: "reservada", to: "recibida" });
  expect(await receptionReadiness(test.db, orderId)).toEqual([]);
  expect(await finalize()).toEqual({ ok: false, code: "invalid_status" });
});

it.each(["prefix", "charset", "padding", "magic", "decoded_size", "oversized_payload"])(
  "3: rechaza firma %s sin subir",
  async (invalid) => {
    await ready();
    let signature = dataUrl;
    if (invalid === "prefix") signature = dataUrl.replace("image/png", "image/jpeg");
    if (invalid === "charset") signature = `${dataUrl}\n`;
    if (invalid === "padding") signature = "data:image/png;base64,AAAA=A==";
    if (invalid === "magic")
      signature = `data:image/png;base64,${Buffer.from("no es PNG").toString("base64")}`;
    if (invalid === "decoded_size") {
      const bytes = Buffer.alloc(MAX_SIGNATURE_BYTES + 1);
      png.copy(bytes);
      signature = `data:image/png;base64,${bytes.toString("base64")}`;
    }
    if (invalid === "oversized_payload")
      signature = `data:image/png;base64,${"A".repeat(Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 + 4)}`;
    const put = vi.spyOn(storage, "put");
    const decode = vi.spyOn(Buffer, "from");
    if (invalid === "oversized_payload") {
      expect(decodeSignature(signature)).toBeNull();
      expect(decode).not.toHaveBeenCalled();
    }
    expect(await finalize(signature)).toEqual({ ok: false, code: "invalid_signature" });
    expect(put).not.toHaveBeenCalled();
    await expectUnchanged();
  },
);

it("3: acepta el límite de 2 MB y rechaza base64 no canónico", () => {
  const bytes = Buffer.alloc(MAX_SIGNATURE_BYTES);
  png.copy(bytes);
  expect(decodeSignature(`data:image/png;base64,${bytes.toString("base64")}`)).toEqual(bytes);
  expect(decodeSignature("data:image/png;base64,iVBORw0KGgp=")).toBeNull();
  expect(decodeSignature("data:image/png;base64,")).toBeNull();
});

it.each([false, true])(
  "4: limpia y revierte si falla la transacción (después de escribir: %s)",
  async (afterWrite) => {
    await ready();
    const failure = new Error("Falla de transacción de prueba");
    const db = new Proxy(test.db, {
      get(target, property, receiver) {
        if (property === "transaction")
          return async (callback: (tx: AppDb) => Promise<unknown>) => {
            expect(storedFiles()).toHaveLength(1);
            if (!afterWrite) throw failure;
            return target.transaction(async (tx) => {
              await callback(tx);
              throw failure;
            });
          };
        return Reflect.get(target, property, receiver);
      },
    }) as AppDb;
    await expect(finalize(dataUrl, owner, db)).rejects.toBe(failure);
    await expectUnchanged();
  },
);

it("5: devuelve already_signed después de comprobar faltantes y firma inválida", async () => {
  await ready();
  await existingSignature();
  const put = vi.spyOn(storage, "put");
  expect(await finalize("")).toEqual({ ok: false, code: "incomplete", missing: ["firma"] });
  expect(await finalize("inválida")).toEqual({ ok: false, code: "invalid_signature" });
  expect(await finalize()).toEqual({ ok: false, code: "already_signed" });
  expect(put).not.toHaveBeenCalled();
  expect(await test.db.select().from(orderSignatures)).toHaveLength(1);
});

it.each(["recepcion", "entrega"] as const)(
  "6: sirve firma %s con acceso y cabeceras privadas",
  async (kind) => {
    const signature = await existingSignature(kind);
    await storage.put(signature.storageKey, png, "image/png");
    const media = (actor: SessionUser | null = owner, key = signature.storageKey) =>
      handleMediaRequest(test.db, storage, actor, key);
    const response = await media();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await media(null)).status).toBe(401);
    expect((await media({ ...owner, branchId: randomUUID() })).status).toBe(404);
    expect((await media(owner, signature.storageKey.replace(kind, "otra"))).status).toBe(404);
    expect((await media(owner, `${signature.storageKey}\n`)).status).toBe(404);
    const absent = `orders/${orderId}/signature-${kind}-${randomUUID()}.png`;
    expect((await media(owner, absent)).status).toBe(404);
    expect((await media(mechanic)).status).toBe(200);
    await updateOrder({ assignedMechanicId: owner.id });
    expect((await media(mechanic)).status).toBe(403);
    await storage.delete(signature.storageKey);
    expect((await media()).status).toBe(404);
  },
);

it.each(["x", "x".repeat(81)])("valida nombre (%s)", async (name) => {
  await ready();
  expect(await finalize(dataUrl, owner, test.db, name)).toEqual({
    ok: false,
    code: "validation_error",
  });
  await expectUnchanged();
});

it.each(["invalid_status", "already_signed", "forbidden"])(
  "revalida %s bajo bloqueo y limpia el objeto",
  async (code) => {
    await ready();
    const db = new Proxy(test.db, {
      get(target, property, receiver) {
        if (property === "transaction")
          return async (callback: (tx: AppDb) => Promise<unknown>) => {
            if (code === "already_signed") await existingSignature();
            else
              await target
                .update(workOrders)
                .set(
                  code === "invalid_status"
                    ? { status: "recibida" }
                    : { assignedMechanicId: owner.id },
                )
                .where(eq(workOrders.id, orderId));
            return target.transaction(callback);
          };
        return Reflect.get(target, property, receiver);
      },
    }) as AppDb;
    expect(await finalize(dataUrl, mechanic, db)).toEqual({ ok: false, code });
    expect(storedFiles()).toEqual([]);
    expect(await test.db.select().from(orderSignatures)).toHaveLength(
      code === "already_signed" ? 1 : 0,
    );
    expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
    expect(await test.db.select().from(auditLog)).toEqual([]);
  },
);
