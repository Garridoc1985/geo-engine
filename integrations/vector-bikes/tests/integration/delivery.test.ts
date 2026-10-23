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
  orderSignatures,
  workOrders,
  workOrderStatusHistory,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { completeDelivery } from "../../src/server/taller/delivery.ts";
import { insertSignatureRow, uploadSignature } from "../../src/server/taller/reception.ts";
import { ORDER_STATUSES } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
const SIGNER = "Cliente de prueba";
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
      name: "Personal de prueba",
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function createOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: owner.branchId,
      name: SIGNER,
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
      status: "lista_para_retirar",
      qcApprovedAt: NOW,
      requestedService: "Revisión general",
      totalClp: 25000,
      paidClp: 25000,
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

async function snapshot() {
  return {
    orders: await test.db.select().from(workOrders),
    signatures: await test.db.select().from(orderSignatures),
    history: await test.db.select().from(workOrderStatusHistory),
    audits: await test.db.select().from(auditLog),
  };
}

function storedFiles() {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
}

function deliver(signatureDataUrl = dataUrl, actor = owner, db = test.db, signedByName = SIGNER) {
  return completeDelivery(db, storage, actor, { orderId, signatureDataUrl, signedByName }, NOW);
}

async function updateOrder(values: Partial<typeof workOrders.$inferInsert>) {
  await test.db.update(workOrders).set(values).where(eq(workOrders.id, orderId));
}

async function existingSignature(kind: "recepcion" | "entrega" = "entrega") {
  const storageKey = await uploadSignature(storage, orderId, kind, png);
  return insertSignatureRow(
    test.db,
    owner,
    { orderId, kind, storageKey, signedByName: SIGNER },
    NOW,
  );
}

beforeEach(async () => {
  test = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "vector-delivery-"));
  storage = createLocalStorage(dir);
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await createActor(branch.id, "owner");
  mechanic = await createActor(branch.id, "mechanic");
  orderId = await createOrder();
  png = await sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  return async () => {
    vi.restoreAllMocks();
    await test.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

it("1: con saldo pendiente conserva la orden byte por byte y no sube objetos", async () => {
  await updateOrder({ paidClp: 0 });
  const before = await snapshot();
  const put = vi.spyOn(storage, "put");
  expect(await deliver("")).toEqual({ ok: false, code: "balance_pending" });
  expect(await deliver()).toEqual({ ok: false, code: "balance_pending" });
  expect(JSON.stringify((await snapshot()).orders)).toBe(JSON.stringify(before.orders));
  expect(await snapshot()).toEqual(before);
  expect(put).not.toHaveBeenCalled();
  expect(storedFiles()).toEqual([]);
});

async function expectDeliveryRecords() {
  const rows = await snapshot();
  expect(rows.orders[0]).toMatchObject({ status: "entregada", deliveredAt: NOW, updatedAt: NOW });
  expect(rows.history).toHaveLength(1);
  expect(rows.history[0]).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    fromStatus: "lista_para_retirar",
    toStatus: "entregada",
    actorUserId: owner.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(rows.audits).toHaveLength(1);
  expect(rows.audits[0]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: owner.id,
    action: "order.delivered",
    entity: "work_order",
    entityId: orderId,
    createdAt: NOW,
    updatedAt: NOW,
    details: { from: "lista_para_retirar", to: "entregada" },
  });
}

it("2: guarda firma de entrega, fecha, historial y auditoría con saldo cero", async () => {
  await existingSignature("recepcion");
  const put = vi.spyOn(storage, "put");
  expect(await deliver(dataUrl, owner, test.db, `  ${SIGNER}  `)).toEqual({ ok: true });
  const signatures = await test.db.select().from(orderSignatures);
  expect(signatures).toHaveLength(2);
  const signature = signatures.find((row) => row.kind === "entrega");
  expect(signature).toMatchObject({
    branchId: owner.branchId,
    workOrderId: orderId,
    kind: "entrega",
    signedByName: SIGNER,
    signedAt: NOW,
    createdBy: owner.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (!signature) throw new Error("Falta la firma de entrega.");
  expect(signature.storageKey).toMatch(
    new RegExp(`^orders/${orderId}/signature-entrega-[0-9a-f-]{36}\\.png$`),
  );
  expect(put).toHaveBeenCalledExactlyOnceWith(signature.storageKey, png, "image/png");
  expect(await storage.exists(signature.storageKey)).toBe(true);
  expect(await storage.get(signature.storageKey)).toEqual(png);
  await expectDeliveryRecords();
  const before = await snapshot();
  expect(await deliver()).toEqual({ ok: false, code: "invalid_status" });
  expect(await snapshot()).toEqual(before);
});

it.each(ORDER_STATUSES.filter((status) => status !== "lista_para_retirar"))(
  "3: rechaza entrega desde %s sin cambios",
  async (status) => {
    await updateOrder({ status });
    const before = await snapshot();
    expect(await deliver()).toEqual({ ok: false, code: "invalid_status" });
    expect(await snapshot()).toEqual(before);
    expect(storedFiles()).toEqual([]);
  },
);

it("el mecánico recibe forbidden antes de validar sin cambiar filas", async () => {
  const before = await snapshot();
  expect(await deliver(dataUrl, mechanic)).toEqual({ ok: false, code: "forbidden" });
  expect(
    await completeDelivery(
      test.db,
      storage,
      mechanic,
      {
        orderId: "inválido",
        signatureDataUrl: "",
        signedByName: "",
      },
      NOW,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await snapshot()).toEqual(before);
  expect(storedFiles()).toEqual([]);
});

it.each([
  ["", "missing_signature"],
  ["inválida", "invalid_signature"],
])("rechaza firma %s con %s sin subir objetos", async (signature, code) => {
  const before = await snapshot();
  const put = vi.spyOn(storage, "put");
  expect(await deliver(signature)).toEqual({ ok: false, code });
  expect(await snapshot()).toEqual(before);
  expect(put).not.toHaveBeenCalled();
});

it("rechaza already_signed después de validar la firma y conserva la firma anterior", async () => {
  const signature = await existingSignature();
  const before = await snapshot();
  const put = vi.spyOn(storage, "put");
  expect(await deliver("")).toEqual({ ok: false, code: "missing_signature" });
  expect(await deliver("inválida")).toEqual({ ok: false, code: "invalid_signature" });
  expect(await deliver(dataUrl, owner, test.db, "x")).toEqual({
    ok: false,
    code: "already_signed",
  });
  expect(await snapshot()).toEqual(before);
  expect(put).not.toHaveBeenCalled();
  expect(await storage.get(signature.storageKey)).toEqual(png);
});

it.each(["", " x ", "x".repeat(81)])("valida nombre %s sin cambios", async (name) => {
  const before = await snapshot();
  expect(await deliver(dataUrl, owner, test.db, name)).toEqual({
    ok: false,
    code: "validation_error",
  });
  expect(await snapshot()).toEqual(before);
  expect(storedFiles()).toEqual([]);
});

it("valida UUID y strings antes de consultar la orden", async () => {
  const before = await snapshot();
  expect(
    await completeDelivery(
      test.db,
      storage,
      owner,
      {
        orderId: "inválido",
        signatureDataUrl: dataUrl,
        signedByName: SIGNER,
      },
      NOW,
    ),
  ).toEqual({ ok: false, code: "validation_error" });
  expect(
    await completeDelivery(
      test.db,
      storage,
      owner,
      {
        orderId,
        signatureDataUrl: null as unknown as string,
        signedByName: SIGNER,
      },
      NOW,
    ),
  ).toEqual({ ok: false, code: "validation_error" });
  expect(await snapshot()).toEqual(before);
  expect(storedFiles()).toEqual([]);
});

it("no encuentra órdenes ausentes, de otra sucursal ni anuladas", async () => {
  const before = await snapshot();
  expect(
    await completeDelivery(
      test.db,
      storage,
      owner,
      {
        orderId: randomUUID(),
        signatureDataUrl: dataUrl,
        signedByName: SIGNER,
      },
      NOW,
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(await deliver(dataUrl, { ...owner, branchId: randomUUID() })).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await snapshot()).toEqual(before);
  await updateOrder({ voidedAt: NOW });
  const voided = await snapshot();
  expect(await deliver()).toEqual({ ok: false, code: "not_found" });
  expect(await snapshot()).toEqual(voided);
  expect(storedFiles()).toEqual([]);
});

it("revierte firma, estado e historial y borra el objeto si falla la auditoría", async () => {
  const before = await snapshot();
  const put = vi.spyOn(storage, "put");
  const remove = vi.spyOn(storage, "delete");
  await test.client.exec(`
    create function reject_delivery_audit() returns trigger language plpgsql as $$
    begin raise exception 'Auditoría no disponible'; end; $$;
    create trigger reject_delivery_audit before insert on audit_log
    for each row execute function reject_delivery_audit();
  `);
  await expect(deliver()).rejects.toThrow();
  expect(put).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledExactlyOnceWith(put.mock.calls[0]?.[0]);
  expect(await snapshot()).toEqual(before);
  expect(storedFiles()).toEqual([]);
});

it.each(["invalid_status", "balance_pending", "already_signed", "not_found"])(
  "revalida %s bajo bloqueo y limpia el objeto nuevo",
  async (code) => {
    let before = await snapshot();
    const db = new Proxy(test.db, {
      get(target, property, receiver) {
        if (property === "transaction")
          return async (callback: (tx: AppDb) => Promise<unknown>) => {
            expect(storedFiles()).toHaveLength(1);
            if (code === "already_signed") await existingSignature();
            else
              await updateOrder(
                code === "invalid_status"
                  ? { status: "control_calidad" }
                  : code === "balance_pending"
                    ? { paidClp: 0 }
                    : { voidedAt: NOW },
              );
            before = await snapshot();
            return target.transaction(callback);
          };
        return Reflect.get(target, property, receiver);
      },
    }) as AppDb;
    expect(await deliver(dataUrl, owner, db)).toEqual({ ok: false, code });
    expect(await snapshot()).toEqual(before);
    expect(storedFiles()).toHaveLength(code === "already_signed" ? 1 : 0);
  },
);

it("dos entregas concurrentes guardan una sola firma y eliminan el objeto sobrante", async () => {
  const results = await Promise.all([deliver(), deliver()]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "invalid_status" }]);
  expect(await test.db.select().from(orderSignatures)).toHaveLength(1);
  expect(storedFiles()).toHaveLength(1);
  await expectDeliveryRecords();
});
