import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import {
  intakeChecks,
  orderPhotos,
  workOrderItems,
  workOrders,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import type { EmailTransport } from "../../src/server/email/transport.ts";
import { createLocalStorage } from "../../src/server/storage/storage.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { finalizeReception } from "../../src/server/taller/reception.ts";
import { INTAKE_CHECK_KEYS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-05T15:00:00.000Z");
const SIGNER = "Ana Pérez";
const CUSTOMER_EMAIL = "ana@ejemplo.cl";

let test: TestDb;
let owner: SessionUser;
let orderId: string;
let storage: ObjectStorage;
let dir: string;
let dataUrl: string;

async function createActor(
  branchId: string,
  role: SessionUser["role"] = "owner",
): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      email: `${randomUUID()}@example.test`,
      name: role === "owner" ? "Dueña" : "Mecánico",
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, email: user.email, name: user.name };
}

async function createOrder(email: string | null, number = 1) {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: SIGNER, phoneE164: "+56912345678", email })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
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
  if (!bike) throw new Error("Falta la bicicleta de prueba.");
  const [order] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number,
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Mantención general",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

/** Deja la orden lista para finalizar: checklist, foto y fecha confirmada. */
async function ready(id = orderId) {
  await test.db.insert(intakeChecks).values(
    INTAKE_CHECK_KEYS.map((itemKey) => ({
      branchId: owner.branchId,
      workOrderId: id,
      itemKey,
      result: "ok",
      createdBy: owner.id,
    })),
  );
  await test.db.insert(orderPhotos).values({
    branchId: owner.branchId,
    workOrderId: id,
    stage: "recepcion",
    retentionClass: "recepcion_6m",
    fullKey: `orders/${id}/${randomUUID()}-full.jpg`,
    thumbKey: `orders/${id}/${randomUUID()}-thumb.jpg`,
    width: 10,
    height: 10,
    createdBy: owner.id,
  });
  await test.db
    .update(workOrders)
    .set({ estimatedDeliveryDate: "2026-10-23", deliveryDateConfirmedAt: NOW })
    .where(eq(workOrders.id, id));
}

function finalize(deps?: { transport: EmailTransport }, id = orderId) {
  return finalizeReception(
    test.db,
    storage,
    owner,
    { orderId: id, signatureDataUrl: dataUrl, signedByName: SIGNER },
    NOW,
    deps,
  );
}

async function receivedAudits(id = orderId) {
  return test.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "notify.received")));
}

describe("aviso al cliente cuando se finaliza la recepción", () => {
  beforeEach(async () => {
    consoleOutbox.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("red deshabilitada en tests");
      }),
    );
    test = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "vector-recibida-"));
    storage = createLocalStorage(dir);
    const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
    if (!branch) throw new Error("Falta la sucursal de prueba.");
    owner = await createActor(branch.id);
    orderId = await createOrder(CUSTOMER_EMAIL);
    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: "#000000" },
    })
      .png()
      .toBuffer();
    dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    return async () => {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
      await test.close();
    };
  });

  it("al finalizar la recepción sale un correo al cliente", async () => {
    await ready();

    expect(await finalize()).toEqual({ ok: true });
    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(CUSTOMER_EMAIL);
    expect(consoleOutbox[0]?.subject).toContain("Recibimos tu bicicleta");
    expect(consoleOutbox[0]?.subject).toContain("OT-00001");
    expect(await receivedAudits()).toHaveLength(1);
  });

  it("una recepción incompleta no envía nada", async () => {
    const result = await finalize();

    expect(result.ok).toBe(false);
    expect(consoleOutbox).toHaveLength(0);
    expect(await receivedAudits()).toHaveLength(0);
  });

  it("sin correo del cliente no se envía nada y la recepción queda finalizada", async () => {
    orderId = await createOrder(null, 2);
    await ready();

    expect(await finalize()).toEqual({ ok: true });
    expect(consoleOutbox).toHaveLength(0);
  });

  it("si el transporte falla, la recepción queda finalizada igual", async () => {
    await ready();
    const flaky: EmailTransport = {
      send: async () => {
        throw new Error("el proveedor rechazó el correo");
      },
    };

    expect(await finalize({ transport: flaky })).toEqual({ ok: true });
    expect(consoleOutbox).toHaveLength(0);
    expect(await receivedAudits()).toHaveLength(0);
  });

  it("una segunda finalización no manda un segundo correo", async () => {
    await ready();
    await finalize();
    expect(consoleOutbox).toHaveLength(1);

    const again = await finalize();

    expect(again.ok).toBe(false);
    expect(consoleOutbox).toHaveLength(1);
    expect(await receivedAudits()).toHaveLength(1);
  });

  it("si la finaliza un mecánico, el correo igual trae las líneas y el total", async () => {
    // `listItems` pasa por `canAccessOrder`. Una orden sin asignar en `recibida`
    // le sigue siendo accesible al mecánico que la recibió; si alguien saca
    // "recibida" de MECHANIC_UNASSIGNED_ACCESS_STATUSES, el correo perdería las
    // líneas en silencio y esta prueba lo caza.
    await ready();
    await test.db.insert(workOrderItems).values({
      branchId: owner.branchId,
      workOrderId: orderId,
      kind: "servicio",
      origin: "inicial",
      description: "Ajuste de frenos",
      quantity: 2,
      unitPriceClp: 9000,
      createdBy: owner.id,
    });
    const mechanic = await createActor(owner.branchId, "mechanic");

    const result = await finalizeReception(
      test.db,
      storage,
      mechanic,
      { orderId, signatureDataUrl: dataUrl, signedByName: SIGNER },
      NOW,
    );

    expect(result).toEqual({ ok: true });
    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.text).toContain("Ajuste de frenos");
    expect(consoleOutbox[0]?.text).toContain("$18.000");
    expect(consoleOutbox[0]?.text).not.toContain("Te enviaremos el presupuesto");
  });

  it("la auditoría no guarda datos personales", async () => {
    await ready();
    await finalize();
    const [entry] = await receivedAudits();

    const details = JSON.stringify(entry?.details ?? {});
    expect(details).not.toContain(CUSTOMER_EMAIL);
    expect(details).not.toContain("+56912345678");
    expect(details).not.toContain(SIGNER);
  });
});
