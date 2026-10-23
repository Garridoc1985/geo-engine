import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, expect, it, vi } from "vitest";
import { checkRateLimit, hashIp, recordAttempt } from "../../src/server/api/handlers.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import {
  workOrderApprovals,
  workOrderItems,
  workOrders,
  workOrderStatusHistory,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import { createApproval, decideApproval, viewApproval } from "../../src/server/taller/approvals.ts";
import { hashShareToken, newShareToken } from "../../src/server/taller/share-tokens.ts";
import { createTestDb, type TestDb } from "../helpers/pglite.ts";

const NOW = new Date("2026-10-08T15:00:00Z");
const LATER = new Date("2026-10-08T15:01:00Z");
const INPUT = {
  description: "Cadena desgastada",
  recommendation: "Reemplazar la cadena",
  priceClp: 35000,
};
let test: TestDb;
let owner: SessionUser;
let orderId: string;

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
      name: "  Ana María Pérez",
      phoneE164: "+56912345678",
      email: "ana@example.test",
      rut: "12.345.678-5",
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
      status: "diagnostico",
      requestedService: "Mantención",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta orden");
  orderId = order.id;
}

async function proposal() {
  const result = await createApproval(test.db, owner, orderId, INPUT, NOW);
  if (!result.ok) throw new Error(result.code);
  return result;
}

beforeEach(async () => {
  test = await createTestDb();
  await seedOwner();
  await seedOrder();
  return async () => {
    await test.close();
  };
});

async function expectDecisionAudit(token: string, ipHash: string | null) {
  const audits = await test.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "approval.decided"));
  expect(audits).toMatchObject([
    {
      branchId: owner.branchId,
      actorUserId: null,
      entity: "work_order",
      entityId: orderId,
      details: { decision: "aprobado" },
      createdAt: LATER,
    },
  ]);
  const stored = JSON.stringify([
    await test.db.select().from(workOrderApprovals),
    await test.db.select().from(auditLog),
  ]);
  for (const secret of [token, "203.0.113.7", "+56912345678", "ana@example.test", "12.345.678-5"])
    expect(stored).not.toContain(secret);
  expect(JSON.stringify(audits)).not.toContain(ipHash);
}

it("1: aprueba, agrega el servicio, recalcula totales y registra historial y auditoría sin datos sensibles", async () => {
  const { token, approvalId } = await proposal();
  const ipHash = hashIp("203.0.113.7");
  expect(await decideApproval(test.db, token, "aprobado", ipHash, LATER)).toEqual({ ok: true });
  expect((await test.db.select().from(workOrderApprovals))[0]).toMatchObject({
    decidedAt: LATER,
    decision: "aprobado",
    decidedIpHash: ipHash,
  });
  expect(await test.db.select().from(workOrderItems)).toMatchObject([
    {
      branchId: owner.branchId,
      workOrderId: orderId,
      kind: "servicio",
      origin: "adicional",
      approvalId,
      description: INPUT.description,
      quantity: 1,
      unitPriceClp: INPUT.priceClp,
      createdBy: owner.id,
    },
  ]);
  expect((await test.db.select().from(workOrders))[0]).toMatchObject({
    totalClp: INPUT.priceClp,
    estimatedMinutes: 0,
    status: "en_reparacion",
  });
  expect((await test.db.select().from(workOrderStatusHistory))[1]).toMatchObject({
    fromStatus: "esperando_aprobacion",
    toStatus: "en_reparacion",
    actorUserId: null,
    note: "Respuesta del cliente",
    createdAt: LATER,
  });
  await expectDecisionAudit(token, ipHash);
});

it("la primera sentencia aplica las cuatro defensas atómicamente y parametriza los valores", async () => {
  const { token } = await proposal();
  const statements: [string, unknown[]][] = [];
  const db = drizzle({
    client: test.client,
    logger: {
      logQuery: (query, params) => {
        statements.push([query, params]);
      },
    },
  }) as unknown as AppDb;
  await decideApproval(db, token, "aprobado", null, LATER);
  const first = statements[0];
  expect(first).toBeDefined();
  const statement = first?.[0].replace(/\s+/g, " ");
  expect(statement).toMatch(/^update "work_order_approvals" set /);
  expect(statement).toContain('"work_order_approvals"."token_hash" = $5');
  expect(statement).toContain('"work_order_approvals"."decided_at" is null');
  expect(statement).toContain('"work_order_approvals"."voided_at" is null');
  expect(statement).toContain(
    'exists (select 1 from "work_orders" o where o.id = "work_order_approvals"."work_order_id" and o.voided_at is null and o.status = $6)',
  );
  expect(statement).toContain(" returning ");
  expect(statement).not.toContain(token);
  expect(first?.[1]).toContain(hashShareToken(token));
  expect(first?.[1]).toContain("esperando_aprobacion");
});

it("2: rechaza sin crear línea y vuelve a en_reparacion", async () => {
  const { token } = await proposal();
  expect(await decideApproval(test.db, token, "rechazado", null, LATER)).toEqual({ ok: true });
  expect((await test.db.select().from(workOrderApprovals))[0]).toMatchObject({
    decision: "rechazado",
    decidedAt: LATER,
    decidedIpHash: null,
  });
  expect(await test.db.select().from(workOrderItems)).toEqual([]);
  expect((await test.db.select().from(workOrders))[0]).toMatchObject({
    status: "en_reparacion",
    totalClp: 0,
  });
  expect(
    (await test.db.select().from(auditLog).where(eq(auditLog.action, "approval.decided")))[0]
      ?.details,
  ).toEqual({ decision: "rechazado" });
});

it("3: dos respuestas simultáneas aplican exactamente una y la otra devuelve already_decided", async () => {
  const { token } = await proposal();
  const results = await Promise.all([
    decideApproval(test.db, token, "aprobado", null, LATER),
    decideApproval(test.db, token, "aprobado", null, LATER),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "already_decided" }]);
  expect(await test.db.select().from(workOrderItems)).toHaveLength(1);
  expect(
    await test.db.select().from(auditLog).where(eq(auditLog.action, "approval.decided")),
  ).toHaveLength(1);
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(2);
});

it("4: token inexistente devuelve invalid en vista y decisión", async () => {
  const token = newShareToken();
  expect(await viewApproval(test.db, token)).toEqual({ view: "invalid" });
  expect(await decideApproval(test.db, token, "aprobado", null, LATER)).toEqual({
    ok: false,
    code: "invalid",
  });
});

it.each(["", "invalido", "a".repeat(44), "!".repeat(43)])(
  "4: forma inválida %s se rechaza sin consultar",
  async (token) => {
    const select = vi.spyOn(test.db, "select");
    const transaction = vi.spyOn(test.db, "transaction");
    expect(await viewApproval(test.db, token)).toEqual({ view: "invalid" });
    expect(await decideApproval(test.db, token, "aprobado", null, LATER)).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  },
);

it("5: vista pendiente contiene solo primer nombre, bicicleta y propuesta", async () => {
  const { token } = await proposal();
  expect(await viewApproval(test.db, token)).toEqual({
    view: "pending",
    approval: { firstName: "Ana", bike: "Trek Marlin", ...INPUT },
  });
});

it("6: cinco intentos en diez minutos bloquean la IP con 429", async () => {
  const ctx = { db: test.db, now: NOW, ip: "203.0.113.7" };
  for (let count = 0; count < 5; count++) await recordAttempt(ctx);
  const limited = await checkRateLimit({ ...ctx, now: LATER });
  expect(limited?.status).toBe(429);
  expect(limited?.headers.get("Retry-After")).toBe("600");
  expect(await checkRateLimit({ ...ctx, ip: "203.0.113.8" })).toBeNull();
  expect(await checkRateLimit({ ...ctx, now: new Date("2026-10-08T15:10:00Z") })).toBeNull();
});

it.each(["approval_voided", "already_decided", "order_voided", "order_status"] as const)(
  "rechaza %s en view y decide sin efectos",
  async (condition) => {
    const { token, approvalId } = await proposal();
    if (condition === "approval_voided")
      await test.db
        .update(workOrderApprovals)
        .set({ voidedAt: NOW })
        .where(eq(workOrderApprovals.id, approvalId));
    if (condition === "already_decided")
      await test.db
        .update(workOrderApprovals)
        .set({ decidedAt: NOW, decision: "rechazado" })
        .where(eq(workOrderApprovals.id, approvalId));
    if (condition === "order_voided")
      await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
    if (condition === "order_status")
      await test.db
        .update(workOrders)
        .set({ status: "en_reparacion" })
        .where(eq(workOrders.id, orderId));
    const before = await test.db.select().from(workOrderApprovals);
    const ordersBefore = await test.db.select().from(workOrders);
    expect(await viewApproval(test.db, token)).toEqual({ view: "invalid" });
    for (const decision of ["aprobado", "rechazado"] as const)
      expect(await decideApproval(test.db, token, decision, null, LATER)).toEqual({
        ok: false,
        code: "already_decided",
      });
    expect(await test.db.select().from(workOrderApprovals)).toEqual(before);
    expect(await test.db.select().from(workOrders)).toEqual(ordersBefore);
    expect(await test.db.select().from(workOrderItems)).toEqual([]);
    expect(await test.db.select().from(auditLog)).toHaveLength(1);
    expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(1);
  },
);

it("mantiene esperando_aprobacion hasta la última respuesta e ignora propuestas anuladas", async () => {
  const first = await proposal();
  const last = await proposal();
  const voided = await proposal();
  await test.db
    .update(workOrderApprovals)
    .set({ voidedAt: NOW })
    .where(eq(workOrderApprovals.id, voided.approvalId));
  await decideApproval(test.db, first.token, "aprobado", null, LATER);
  expect((await test.db.select().from(workOrders))[0]?.status).toBe("esperando_aprobacion");
  await decideApproval(test.db, last.token, "rechazado", null, LATER);
  expect((await test.db.select().from(workOrders))[0]?.status).toBe("en_reparacion");
  expect(await test.db.select().from(workOrderItems)).toHaveLength(1);
});

it("revierte decisión, línea, total, estado e historial cuando falla la auditoría", async () => {
  const { token } = await proposal();
  await test.db.execute(
    sql`alter table audit_log add constraint fail_decision_audit check (action <> 'approval.decided')`,
  );
  await expect(decideApproval(test.db, token, "aprobado", null, LATER)).rejects.toThrow();
  expect((await test.db.select().from(workOrderApprovals))[0]).toMatchObject({
    decidedAt: null,
    decision: null,
    decidedIpHash: null,
  });
  expect((await test.db.select().from(workOrders))[0]).toMatchObject({
    status: "esperando_aprobacion",
    totalClp: 0,
  });
  expect(await test.db.select().from(workOrderItems)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(1);
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});
