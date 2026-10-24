import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { consoleOutbox } from "../../src/server/email/transport.ts";
import type { EmailTransport } from "../../src/server/email/transport.ts";
import { qcFormSchema, submitQc } from "../../src/server/taller/qc.ts";
import { QC_CHECK_KEYS } from "../../src/server/taller/rules.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00.000Z");
const CUSTOMER_EMAIL = "ana@ejemplo.cl";

let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let orderId: string;
let orderNumber = 0;

function input(failed: (typeof QC_CHECK_KEYS)[number][] = []) {
  return qcFormSchema.parse({
    checks: Object.fromEntries(
      QC_CHECK_KEYS.map((key) => [
        key,
        { result: failed.includes(key) ? "falla" : "ok", note: "" },
      ]),
    ),
  });
}

async function createUser(branchId: string, role: "owner" | "mechanic"): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: role === "owner" ? "Dueña" : "Mecánico",
      email: `${role}-${randomUUID()}@example.test`,
      passwordHash: "hash-de-prueba",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function createOrder(email: string | null) {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Ana Pérez", phoneE164: "+56912345678", email })
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
      number: ++orderNumber,
      customerId: customer.id,
      bikeId: bike.id,
      requestedService: "Revisión general",
      status: "control_calidad",
      assignedMechanicId: mechanic.id,
      createdBy: owner.id,
      totalClp: 45000,
      paidClp: 20000,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  return order.id;
}

/** Deja la orden lista para una segunda aprobación, como tras un control rechazado. */
async function backToQc() {
  await test.db
    .update(workOrders)
    .set({ status: "control_calidad" })
    .where(eq(workOrders.id, orderId));
}

async function readyAudits() {
  return test.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, orderId), eq(auditLog.action, "notify.ready_for_pickup")));
}

describe("aviso al cliente cuando la bici queda lista para retirar", () => {
  beforeEach(async () => {
    consoleOutbox.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("red deshabilitada en tests");
      }),
    );
    orderNumber = 0;
    test = await createTestDb();
    const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
    if (!branch) throw new Error("Falta la sucursal de prueba.");
    owner = await createUser(branch.id, "owner");
    mechanic = await createUser(branch.id, "mechanic");
    orderId = await createOrder(CUSTOMER_EMAIL);
    return () => {
      vi.unstubAllGlobals();
      return test.close();
    };
  });

  it("al aprobar el control sale un correo al cliente", async () => {
    expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
      ok: true,
      status: "lista_para_retirar",
    });

    expect(consoleOutbox).toHaveLength(1);
    expect(consoleOutbox[0]?.to).toBe(CUSTOMER_EMAIL);
    expect(consoleOutbox[0]?.subject).toContain("lista para retirar");
    expect(consoleOutbox[0]?.subject).toContain("OT-00001");
    expect(await readyAudits()).toHaveLength(1);
  });

  it("si el control falla no se envía nada", async () => {
    expect(await submitQc(test.db, owner, orderId, input(["frenos"]), NOW)).toEqual({
      ok: true,
      status: "en_reparacion",
    });

    expect(consoleOutbox).toHaveLength(0);
    expect(await readyAudits()).toHaveLength(0);
  });

  it("sin correo del cliente no se envía nada y la aprobación sigue siendo exitosa", async () => {
    orderId = await createOrder(null);

    expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
      ok: true,
      status: "lista_para_retirar",
    });
    expect(consoleOutbox).toHaveLength(0);
  });

  it("si el transporte falla, la aprobación sigue siendo exitosa", async () => {
    const flaky: EmailTransport = {
      send: async () => {
        throw new Error("el proveedor rechazó el correo");
      },
    };

    expect(await submitQc(test.db, owner, orderId, input(), NOW, { transport: flaky })).toEqual({
      ok: true,
      status: "lista_para_retirar",
    });
    expect(consoleOutbox).toHaveLength(0);
  });

  it("una segunda aprobación no manda un segundo correo", async () => {
    await submitQc(test.db, owner, orderId, input(), NOW);
    expect(consoleOutbox).toHaveLength(1);

    await backToQc();
    expect(await submitQc(test.db, owner, orderId, input(), NOW)).toEqual({
      ok: true,
      status: "lista_para_retirar",
    });

    expect(consoleOutbox).toHaveLength(1);
    expect(await readyAudits()).toHaveLength(1);
  });

  it("el registro de auditoría no guarda el correo del cliente", async () => {
    await submitQc(test.db, owner, orderId, input(), NOW);
    const [entry] = await readyAudits();

    expect(JSON.stringify(entry?.details ?? {})).not.toContain(CUSTOMER_EMAIL);
    expect(JSON.stringify(entry?.details ?? {})).not.toContain("+56912345678");
  });
});
