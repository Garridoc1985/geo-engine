import { createHash, randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import {
  workOrderApprovals,
  workOrders,
  workOrderStatusHistory,
} from "../../src/server/db/schema-orders.ts";
import { auditLog, bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  approvalFormSchema,
  approvalLink,
  createApproval,
  listApprovals,
  regenerateApprovalLink,
  whatsappShareLink,
} from "../../src/server/taller/approvals.ts";
import { hashShareToken, shareTokenSchema } from "../../src/server/taller/share-tokens.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({ db: null as AppDb | null, user: null as SessionUser | null }));
vi.mock("../../src/server/db/client.ts", async (original) => ({
  ...(await original<typeof import("../../src/server/db/client.ts")>()),
  getDb: () => holder.db,
}));
vi.mock("../../src/server/auth/admin-auth.ts", async (original) => ({
  ...(await original<typeof import("../../src/server/auth/admin-auth.ts")>()),
  requireAdmin: async () => holder.user,
}));
const { default: AdditionalPage } = await import(
  "../../src/pages/taller/ordenes/[id]/adicional.astro"
);
const NOW = new Date("2026-10-08T15:00:00.000Z");
const LATER = new Date("2026-10-08T15:01:00.000Z");
const SITE = "https://vectorbikes.cl";
const NOT_FOUND = { ok: false, code: "not_found" };
const INPUT = {
  description: "Cadena desgastada",
  recommendation: "Reemplazar la cadena",
  priceClp: 35000,
};
let test: TestDb;
let owner: SessionUser;
let orderId: string;

async function seedOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({
      branchId: owner.branchId,
      name: "Ana María Pérez",
      phoneE164: "+56912345678",
    })
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
      number: 1,
      customerId: customer.id,
      bikeId: bike.id,
      status: "diagnostico",
      requestedService: "Mantención",
      createdBy: owner.id,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  orderId = order.id;
}

async function proposal(actor = owner) {
  const result = await createApproval(test.db, actor, orderId, INPUT, NOW);
  if (!result.ok) throw new Error(`No se creó la propuesta: ${result.code}`);
  return result;
}

async function expectTokenAbsent(token: string) {
  const approvals = await test.db.select().from(workOrderApprovals);
  const audits = await test.db.select().from(auditLog);
  for (const row of [...approvals, ...audits]) {
    for (const value of Object.values(row)) expect(JSON.stringify(value)).not.toContain(token);
  }
}

async function render(data?: Record<string, string>, origin = SITE, id = orderId) {
  const request = new Request(`${SITE}/taller/ordenes/${id}/adicional`, {
    method: data ? "POST" : "GET",
    headers: data ? { origin, "content-type": "application/x-www-form-urlencoded" } : {},
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(AdditionalPage, { request, params: { id } });
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
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
  if (!user) throw new Error("Falta el usuario de prueba.");
  owner = { id: user.id, branchId: branch.id, role: "owner", name: user.name, email: user.email };
  holder.db = test.db;
  holder.user = owner;
  await seedOrder();
  return async () => {
    holder.db = null;
    holder.user = null;
    await test.close();
  };
});

it.each(["diagnostico", "en_reparacion", "esperando_repuesto"])(
  "1: propone desde %s y pasa a esperando_aprobacion con historial",
  async (status) => {
    await test.db.update(workOrders).set({ status }).where(eq(workOrders.id, orderId));
    const result = await proposal();
    const [approval] = await test.db.select().from(workOrderApprovals);
    expect(approval).toMatchObject({
      id: result.approvalId,
      branchId: owner.branchId,
      workOrderId: orderId,
      ...INPUT,
      createdBy: owner.id,
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: null,
      decision: null,
      voidedAt: null,
    });
    expect((await test.db.select().from(workOrders))[0]?.status).toBe("esperando_aprobacion");
    expect(await test.db.select().from(workOrderStatusHistory)).toMatchObject([
      {
        branchId: owner.branchId,
        workOrderId: orderId,
        fromStatus: status,
        toStatus: "esperando_aprobacion",
        actorUserId: owner.id,
        note: "Propuesta de adicional",
        createdAt: NOW,
      },
    ]);
  },
);

it("2: devuelve 43 caracteres base64url, guarda solo sha256 hex y no filtra el token en ninguna columna", async () => {
  const { token } = await proposal();
  expect(shareTokenSchema.parse(token)).toBe(token);
  const expectedHash = createHash("sha256").update(token).digest("hex");
  expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);
  expect((await test.db.select().from(workOrderApprovals))[0]?.tokenHash).toBe(expectedHash);
  await expectTokenAbsent(token);
});

it("3: codifica el mensaje y el enlace en WhatsApp con solo dígitos del teléfono", async () => {
  const { token } = await proposal();
  const link = `${SITE}/aprobacion/${token}`;
  expect(approvalLink(`${SITE}/`, token)).toBe(link);
  const message = `Hola Ana, en Vector Bikes revisamos tu bicicleta y encontramos algo. Revisa y responde aquí: ${link}`;
  expect(whatsappShareLink("+56912345678", message)).toBe(
    `https://wa.me/56912345678?text=${encodeURIComponent(message)}`,
  );
});

it("4: rechaza al mecánico antes de validar y no cambia filas", async () => {
  expect(
    await createApproval(
      test.db,
      { ...owner, role: "mechanic" },
      orderId,
      { ...INPUT, priceClp: 0 },
      NOW,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await test.db.select().from(workOrderApprovals)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect((await test.db.select().from(workOrders))[0]?.status).toBe("diagnostico");
});

it("5: regenera una pendiente, invalida el hash anterior y audita solo su id", async () => {
  const original = await proposal();
  const result = await regenerateApprovalLink(test.db, owner, original.approvalId, LATER);
  if (!result.ok) throw new Error("No se regeneró el enlace.");
  expect(result.token).not.toBe(original.token);
  expect(
    await test.db
      .select()
      .from(workOrderApprovals)
      .where(eq(workOrderApprovals.tokenHash, hashShareToken(original.token))),
  ).toEqual([]);
  expect((await test.db.select().from(workOrderApprovals))[0]).toMatchObject({
    id: original.approvalId,
    tokenHash: hashShareToken(result.token),
    updatedAt: LATER,
  });
  expect(
    (
      await test.db.select().from(auditLog).where(eq(auditLog.action, "approval.link_regenerated"))
    )[0],
  ).toMatchObject({
    branchId: owner.branchId,
    actorUserId: owner.id,
    details: { approvalId: original.approvalId },
    createdAt: LATER,
  });
  await expectTokenAbsent(original.token);
  await expectTokenAbsent(result.token);
});

it("6: audita approval.created dentro de la transacción sin token ni texto libre en ninguna columna", async () => {
  const { token, approvalId } = await proposal();
  const audits = await test.db.select().from(auditLog);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    branchId: owner.branchId,
    actorUserId: owner.id,
    action: "approval.created",
    entity: "work_order",
    entityId: orderId,
    details: { approvalId, priceClp: INPUT.priceClp },
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(audits[0]?.details).toEqual({ approvalId, priceClp: INPUT.priceClp });
  expect(JSON.stringify(audits)).not.toContain(INPUT.description);
  expect(JSON.stringify(audits)).not.toContain(INPUT.recommendation);
  await expectTokenAbsent(token);
});

it("agrega otra pendiente sin duplicar el cambio de estado ni historial", async () => {
  await proposal();
  await proposal();
  expect(await test.db.select().from(workOrderApprovals)).toHaveLength(2);
  expect(await test.db.select().from(workOrderStatusHistory)).toHaveLength(1);
});

it.each([
  "reservada",
  "recibida",
  "control_calidad",
  "lista_para_retirar",
  "entregada",
  "cancelada",
  "trabajo_rechazado",
])("rechaza el estado %s sin escribir propuesta o auditoría", async (status) => {
  await test.db
    .update(workOrders)
    .set({ status, qcApprovedAt: NOW })
    .where(eq(workOrders.id, orderId));
  expect(await createApproval(test.db, owner, orderId, INPUT, NOW)).toEqual({
    ok: false,
    code: "invalid_status",
  });
  expect(await test.db.select().from(workOrderApprovals)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("aísla creación, listado y regeneración por sucursal y excluye órdenes anuladas", async () => {
  const original = await proposal();
  const foreign = { ...owner, branchId: randomUUID() };
  expect(await createApproval(test.db, foreign, orderId, INPUT, NOW)).toEqual(NOT_FOUND);
  expect(await regenerateApprovalLink(test.db, foreign, original.approvalId, LATER)).toEqual(
    NOT_FOUND,
  );
  expect(await listApprovals(test.db, foreign, orderId)).toEqual([]);
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
  expect(await createApproval(test.db, owner, orderId, INPUT, NOW)).toEqual(NOT_FOUND);
  expect(await regenerateApprovalLink(test.db, owner, original.approvalId, LATER)).toEqual(
    NOT_FOUND,
  );
});

it.each(["aprobado", "rechazado", "anulado"] as const)(
  "no regenera una propuesta %s",
  async (state) => {
    const original = await proposal();
    await test.db
      .update(workOrderApprovals)
      .set(
        state === "anulado"
          ? { voidedAt: NOW, voidedBy: owner.id }
          : { decidedAt: NOW, decision: state },
      )
      .where(eq(workOrderApprovals.id, original.approvalId));
    expect(await regenerateApprovalLink(test.db, owner, original.approvalId, LATER)).toEqual(
      NOT_FOUND,
    );
    expect((await test.db.select().from(workOrderApprovals))[0]?.tokenHash).toBe(
      hashShareToken(original.token),
    );
    expect(await test.db.select().from(auditLog)).toHaveLength(1);
  },
);

it("revierte propuesta, estado e historial cuando falla la auditoría", async () => {
  await test.db.execute(
    sql`alter table audit_log add constraint fail_approval_audit check (action <> 'approval.created')`,
  );
  await expect(createApproval(test.db, owner, orderId, INPUT, NOW)).rejects.toThrow();
  expect(await test.db.select().from(workOrderApprovals)).toEqual([]);
  expect(await test.db.select().from(workOrderStatusHistory)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  expect((await test.db.select().from(workOrders))[0]?.status).toBe("diagnostico");
});

it("POST muestra el enlace una vez, WhatsApp usa el primer nombre y GET no recupera token ni hash", async () => {
  const response = await render({ action: "create", ...INPUT, priceClp: String(INPUT.priceClp) });
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await response.text();
  const token = html.match(/\/aprobacion\/([A-Za-z0-9_-]{43})/)?.[1];
  expect(token).toBeDefined();
  if (!token) throw new Error("Falta el enlace del POST.");
  expect(html).toContain("Copia este enlace ahora; no se vuelve a mostrar");
  const message = `Hola Ana, en Vector Bikes revisamos tu bicicleta y encontramos algo. Revisa y responde aquí: ${approvalLink(SITE, token)}`;
  expect(html).toContain(whatsappShareLink("+56912345678", message));
  const get = await render();
  const getHtml = await get.text();
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect(getHtml).not.toContain(token);
  expect(getHtml).not.toContain(hashShareToken(token));
  expect(getHtml).toContain("Generar nuevo enlace");
  expect(getHtml).toContain("Pendiente");
});

it("la página regenera sin redirigir y no muestra el enlace al volver por GET", async () => {
  const original = await proposal();
  const response = await render({ action: "regenerate", approvalId: original.approvalId });
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).not.toContain(original.token);
  expect(html).toContain("Copia este enlace ahora; no se vuelve a mostrar");
  expect(await (await render()).text()).not.toContain("Enlace de aprobación");
});

it("la página protege sesión, permiso, origen y orden con no-store en cada respuesta", async () => {
  holder.user = null;
  expect((await render()).status).toBe(303);
  holder.user = { ...owner, role: "mechanic" };
  expect((await render()).status).toBe(403);
  holder.user = owner;
  for (const response of [
    await render({ action: "create" }, "https://otro.cl"),
    await render(undefined, SITE, "invalido"),
    await render(undefined, SITE, randomUUID()),
  ]) {
    expect([403, 404]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect(await test.db.select().from(workOrderApprovals)).toEqual([]);
});

it("valida límites del problema y la recomendación y vincula errores a los campos", async () => {
  for (const key of ["description", "recommendation"] as const) {
    for (const value of ["1234", "x".repeat(501)])
      expect(approvalFormSchema.safeParse({ ...INPUT, [key]: value }).success).toBe(false);
  }
  const response = await render({
    action: "create",
    description: "X",
    recommendation: "X",
    priceClp: "0",
  });
  expect(response.status).toBe(422);
  const html = await response.text();
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="description-error"');
  expect(await test.db.select().from(workOrderApprovals)).toEqual([]);
});
