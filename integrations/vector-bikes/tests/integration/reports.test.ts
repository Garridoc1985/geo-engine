import { createHash, randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { workOrderItems, workOrders } from "../../src/server/db/schema-orders.ts";
import { serviceReports } from "../../src/server/db/schema-reports.ts";
import { auditLog } from "../../src/server/db/schema-taller.ts";
import { branches } from "../../src/server/db/schema.ts";
import type { ObjectStorage } from "../../src/server/storage/storage.ts";
import { whatsappShareLink } from "../../src/server/taller/approvals.ts";
import {
  buildReportSnapshot,
  generateReport,
  getReportForStaff,
  loadReportPhotos,
} from "../../src/server/taller/reports.ts";
import { hashShareToken } from "../../src/server/taller/share-tokens.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({
  db: null as AppDb | null,
  user: null as SessionUser | null,
  storage: null as ObjectStorage | null,
}));
vi.mock("../../src/server/db/client.ts", async (original) => ({
  ...(await original<typeof import("../../src/server/db/client.ts")>()),
  getDb: () => holder.db,
}));
vi.mock("../../src/server/auth/admin-auth.ts", async (original) => ({
  ...(await original<typeof import("../../src/server/auth/admin-auth.ts")>()),
  requireAdmin: async () => holder.user,
}));
vi.mock("../../src/server/storage/storage.ts", async (original) => ({
  ...(await original<typeof import("../../src/server/storage/storage.ts")>()),
  getStorage: async () => holder.storage,
}));
const { default: ReportPage } = await import("../../src/pages/taller/ordenes/[id]/informe.astro");
const NOW = new Date("2026-10-08T15:00:00.000Z");
const LATER = new Date("2026-10-08T16:00:00.000Z");
const SITE = "https://vectorbikes.cl";
const INPUT = {
  recommendations: "  Lubricar la cadena  ",
  nextChecks: "  Revisar en seis meses  ",
};
const PRIVATE = { phoneE164: "+56912345678", email: "ana@example.test", rut: "12.345.678-5" };
let test: TestDb;
let owner: SessionUser;
let order: typeof workOrders.$inferSelect;
let oldOrder: typeof workOrders.$inferSelect;
let storage: ObjectStorage;
let objects: Map<string, Buffer>;

async function seedIdentity() {
  const branchId = randomUUID();
  owner = { id: randomUUID(), branchId, role: "owner", name: "Dueño", email: "owner@example.test" };
  const customerId = randomUUID();
  const bikeId = randomUUID();
  await test.db.execute(sql`insert into branches (id, name) values (${branchId}, 'Vitacura')`);
  await test.db.execute(sql`insert into users (id, branch_id, role, name, email, password_hash)
    values (${owner.id}, ${branchId}, 'owner', 'Dueño', ${owner.email}, 'hash')`);
  await test.db.execute(sql`insert into customers (id, branch_id, name, phone_e164, email, rut)
    values (${customerId}, ${branchId}, ' Ana María Pérez ', ${PRIVATE.phoneE164}, ${PRIVATE.email}, ${PRIVATE.rut})`);
  await test.db.execute(sql`insert into bikes (id, branch_id, customer_id, brand, model, bike_type, km_noted)
    values (${bikeId}, ${branchId}, ${customerId}, 'Trek', 'Marlin', 'mtb', 1250)`);
  const orders = await test.db
    .insert(workOrders)
    .values(
      [1, 2].map((number) => ({
        branchId,
        number,
        customerId,
        bikeId,
        status: "lista_para_retirar",
        requestedService: "Mantención",
        diagnosis: "Cadena desgastada",
        totalClp: 25000,
        qcApprovedAt: NOW,
        receivedAt: NOW,
        createdBy: owner.id,
      })),
    )
    .returning();
  if (!orders[0] || !orders[1]) throw new Error("Faltan órdenes.");
  [order, oldOrder] = [orders[0], orders[1]];
}

async function seedWork() {
  const serviceId = randomUUID();
  await test.db.execute(sql`insert into services (id, branch_id, name, estimated_minutes, aftercare)
    values (${serviceId}, ${owner.branchId}, 'Mantención', 60, '  Lubricar semanalmente  ')`);
  await test.db.execute(sql`insert into work_order_items
    (branch_id, work_order_id, kind, origin, service_id, description, quantity, unit_price_clp, created_by, voided_at) values
    (${owner.branchId}, ${order.id}, 'servicio', 'inicial', ${serviceId}, 'Mantención', 1, 5000, ${owner.id}, null),
    (${owner.branchId}, ${order.id}, 'servicio', 'inicial', ${serviceId}, 'Ajuste', 2, 5000, ${owner.id}, null),
    (${owner.branchId}, ${order.id}, 'servicio', 'inicial', ${serviceId}, 'Trabajo anulado', 1, 5000, ${owner.id}, ${NOW})`);
  await test.db.execute(sql`insert into intake_checks (branch_id, work_order_id, item_key, result, note, created_by) values
    (${owner.branchId}, ${order.id}, 'cadena', 'malo', 'Desgastada', ${owner.id}),
    (${owner.branchId}, ${order.id}, 'frenos', 'revisar', 'Ajustar', ${owner.id}),
    (${owner.branchId}, ${order.id}, 'ruedas', 'ok', null, ${owner.id})`);
  await test.db.execute(sql`insert into work_order_approvals
    (branch_id, work_order_id, description, recommendation, price_clp, token_hash, decision, decided_at, created_by, voided_at) values
    (${owner.branchId}, ${order.id}, 'Cambio de neumático', 'Reemplazar pronto', 10000, ${randomUUID()}, 'rechazado', ${NOW}, ${owner.id}, null),
    (${owner.branchId}, ${order.id}, 'Aprobado', 'Aprobado', 10000, ${randomUUID()}, 'aprobado', ${NOW}, ${owner.id}, null),
    (${owner.branchId}, ${order.id}, 'Anulado', 'Anulado', 10000, ${randomUUID()}, 'rechazado', ${NOW}, ${owner.id}, ${NOW})`);
}

async function seedComponents() {
  const componentId = randomUUID();
  await test.db.execute(sql`insert into bike_components
    (id, branch_id, bike_id, work_order_id, component_type, brand, model, installed_at, created_by) values
    (${componentId}, ${owner.branchId}, ${order.bikeId}, ${order.id}, 'Cadena', 'Shimano', 'CN-M6100', '2026-10-08', ${owner.id})`);
  await test.db.execute(sql`insert into bike_components
    (branch_id, bike_id, work_order_id, component_type, brand, model, installed_at, replaced_at, replaced_by_component_id, created_by) values
    (${owner.branchId}, ${order.bikeId}, ${oldOrder.id}, 'Cadena', 'Shimano', 'CN-HG54', '2026-10-01', '2026-10-08', ${componentId}, ${owner.id})`);
}

async function seedPhotos() {
  for (const stage of ["recepcion", "terminado", "reparacion"] as const) {
    for (let index = 0; index < 3; index++) {
      const id = randomUUID();
      const thumbKey = `orders/${order.id}/${id}-thumb.jpg`;
      await test.db.execute(sql`insert into order_photos
        (id, branch_id, work_order_id, stage, retention_class, full_key, thumb_key, width, height, voided_at, created_by)
        values (${id}, ${owner.branchId}, ${order.id}, ${stage},
        ${stage === "recepcion" ? "recepcion_6m" : "permanente"}, ${`orders/${order.id}/${id}-full.jpg`},
        ${thumbKey}, 640, 480, ${index === 2 ? NOW : null}, ${owner.id})`);
      objects.set(thumbKey, Buffer.from(`miniatura-${stage}-${index}`));
    }
  }
}

function failure(code: string) {
  return { ok: false, code };
}

async function generate(input = INPUT, now = NOW) {
  const result = await generateReport(test.db, owner, order.id, input, now);
  if (!result.ok) throw new Error(`Falló el informe: ${result.code}`);
  return result;
}

async function reportRow() {
  const [row] = await test.db.select().from(serviceReports);
  if (!row) throw new Error("Falta el informe.");
  return row;
}

async function render(data?: Record<string, string>, origin = SITE, id = order.id) {
  const request = new Request(`${SITE}/taller/ordenes/${id}/informe`, {
    method: data ? "POST" : "GET",
    headers: data ? { origin, "content-type": "application/x-www-form-urlencoded" } : {},
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToResponse(ReportPage, { request, params: { id } });
}

beforeEach(async () => {
  test = await createTestDb();
  objects = new Map();
  storage = {
    get: async (key) => objects.get(key) ?? null,
    put: vi.fn<ObjectStorage["put"]>(),
    delete: vi.fn<ObjectStorage["delete"]>(),
    exists: async (key) => objects.has(key),
  };
  await seedIdentity();
  await seedWork();
  await seedComponents();
  await seedPhotos();
  holder.db = test.db;
  holder.user = owner;
  holder.storage = storage;
  return () => test.close();
});

it("1: guarda el snapshot versión 1 completo, excluyendo anulados", async () => {
  await generate();
  const report = await getReportForStaff(test.db, owner, order.id);
  expect(report?.generatedAt).toEqual(NOW);
  const snapshot = report?.snapshot;
  expect(snapshot).toMatchObject({
    version: 1,
    orderNumber: "OT-00001",
    bike: { brand: "Trek", model: "Marlin", type: "mtb", kmNoted: 1250 },
    diagnosis: "Cadena desgastada",
    recommendations: "Lubricar la cadena",
    nextChecks: "Revisar en seis meses",
    totalClp: 25000,
  });
  expect(snapshot?.workDone).toHaveLength(2);
  expect(snapshot?.workDone).toEqual(
    expect.arrayContaining([
      { description: "Mantención", quantity: 1 },
      { description: "Ajuste", quantity: 2 },
    ]),
  );
  expect(snapshot?.problemsFound).toEqual([
    { item: "Cadena", result: "malo", note: "Desgastada" },
    { item: "Frenos", result: "revisar", note: "Ajustar" },
  ]);
  expect(snapshot?.componentsReplaced).toHaveLength(1);
  expect(snapshot?.componentsReplaced[0]?.replaces).toBe("Cadena Shimano CN-HG54");
  expect(snapshot?.photosBefore).toHaveLength(2);
  expect(snapshot?.photosAfter).toHaveLength(2);
  expect(snapshot?.rejectedWork).toEqual([
    {
      description: "Cambio de neumático",
      recommendation: "Reemplazar pronto",
      decidedAt: NOW.toISOString(),
    },
  ]);
  expect(snapshot).toEqual(await buildReportSnapshot(test.db, order.id, INPUT));
  expect(JSON.stringify(snapshot)).not.toMatch(/unitPrice|priceClp|tokenHash|fullKey/);
});

it("2: entrega 43 caracteres y guarda solo sha256, con auditoría sin token", async () => {
  const { token } = await generate();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = await reportRow();
  expect(row.shareTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  const audits = await test.db.select().from(auditLog);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ action: "report.generated", entityId: order.id, details: {} });
  expect(JSON.stringify([row, audits])).not.toContain(token);
});

it("3: regenerar reemplaza el snapshot y el hash, conservando una sola fila", async () => {
  const original = await generate();
  const previous = await reportRow();
  await test.db.execute(
    sql`update work_orders set diagnosis = 'Diagnóstico actualizado' where id = ${order.id}`,
  );
  expect((await getReportForStaff(test.db, owner, order.id))?.snapshot.diagnosis).toBe(
    "Cadena desgastada",
  );
  const current = await generate(
    { recommendations: "Nueva recomendación", nextChecks: "Un mes" },
    LATER,
  );
  expect(current.token).not.toBe(original.token);
  expect(
    await test.db
      .select()
      .from(serviceReports)
      .where(eq(serviceReports.shareTokenHash, hashShareToken(original.token))),
  ).toEqual([]);
  expect(await test.db.select().from(serviceReports)).toHaveLength(1);
  expect(await reportRow()).toMatchObject({
    id: previous.id,
    shareTokenHash: createHash("sha256").update(current.token).digest("hex"),
    generatedAt: LATER,
    generatedBy: owner.id,
    updatedAt: LATER,
    createdAt: NOW,
    snapshot: {
      diagnosis: "Diagnóstico actualizado",
      recommendations: "Nueva recomendación",
      nextChecks: "Un mes",
    },
  });
});

it("4: incluye solo el primer nombre, sin teléfono, correo ni RUT", async () => {
  await generate();
  const snapshot = (await reportRow()).snapshot;
  expect(snapshot).toMatchObject({ customerFirstName: "Ana" });
  for (const value of [...Object.values(PRIVATE), "María", "Pérez"])
    expect(JSON.stringify(snapshot)).not.toContain(value);
});

it("5: rechaza al mecánico antes de validar y no escribe filas", async () => {
  expect(await generateReport(test.db, { ...owner, role: "mechanic" }, order.id, {}, NOW)).toEqual(
    failure("forbidden"),
  );
  expect(await test.db.select().from(serviceReports)).toEqual([]);
  expect(await test.db.select().from(auditLog)).toEqual([]);
  expect(await getReportForStaff(test.db, { ...owner, role: "mechanic" }, order.id)).toBeNull();
});

it("rechaza en_reparacion y acepta entregada", async () => {
  await test.db.execute(
    sql`update work_orders set status = 'en_reparacion' where id = ${order.id}`,
  );
  expect(await generateReport(test.db, owner, order.id, INPUT, NOW)).toEqual(
    failure("invalid_status"),
  );
  expect(await test.db.select().from(serviceReports)).toEqual([]);
  await test.db.execute(
    sql`update work_orders set status = 'entregada', paid_clp = 25000, delivered_at = ${LATER} where id = ${order.id}`,
  );
  await generate();
  expect((await getReportForStaff(test.db, owner, order.id))?.snapshot.deliveredAt).toBe(
    LATER.toISOString(),
  );
});

it("valida ambos límites y tipos sin escribir", async () => {
  for (const key of ["recommendations", "nextChecks"] as const) {
    for (const value of ["x".repeat(2001), null, 42])
      expect(
        await generateReport(test.db, owner, order.id, { ...INPUT, [key]: value }, NOW),
      ).toEqual({ ok: false, code: "validation_error" });
  }
  expect(await test.db.select().from(serviceReports)).toEqual([]);
  expect((await generate({ recommendations: "x".repeat(2000), nextChecks: "" })).ok).toBe(true);
});

it("aísla las relaciones por sucursal y excluye órdenes anuladas o inexistentes", async () => {
  const [foreign] = await test.db.insert(branches).values({ name: "Otra" }).returning();
  if (!foreign) throw new Error("Falta la sucursal.");
  await test.db.insert(workOrderItems).values({
    branchId: foreign.id,
    workOrderId: order.id,
    kind: "servicio",
    origin: "inicial",
    description: "Ajeno",
    unitPriceClp: 10,
    createdBy: owner.id,
  });
  await generate();
  expect(JSON.stringify((await reportRow()).snapshot)).not.toContain("Ajeno");
  const actor = { ...owner, branchId: foreign.id };
  expect(await generateReport(test.db, actor, order.id, INPUT, NOW)).toEqual(failure("not_found"));
  expect(await getReportForStaff(test.db, actor, order.id)).toBeNull();
  for (const id of [randomUUID(), "invalido"])
    expect(await generateReport(test.db, owner, id, INPUT, NOW)).toEqual(failure("not_found"));
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, order.id));
  expect(await generateReport(test.db, owner, order.id, INPUT, NOW)).toEqual(failure("not_found"));
  expect(await getReportForStaff(test.db, owner, order.id)).toBeNull();
});

it("carga miniaturas como data URLs y omite un objeto ausente", async () => {
  const snapshot = await buildReportSnapshot(test.db, order.id, INPUT);
  if (!snapshot?.photosBefore[0]) throw new Error("Falta el snapshot.");
  const missing = snapshot.photosBefore[0];
  objects.delete(missing.thumbKey);
  const photos = await loadReportPhotos(storage, snapshot);
  expect(Object.keys(photos)).toHaveLength(3);
  expect(photos[missing.photoId]).toBeUndefined();
  for (const photo of [...snapshot.photosBefore, ...snapshot.photosAfter].filter(
    (photo) => photo.photoId !== missing.photoId,
  ))
    expect(photos[photo.photoId]).toBe(
      `data:image/jpeg;base64,${objects.get(photo.thumbKey)?.toString("base64")}`,
    );
});

it("POST muestra el enlace una vez y GET conserva el informe sin token ni hash", async () => {
  expect(await (await render()).text()).toContain("Lubricar semanalmente");
  const response = await render(INPUT);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  const token = html.match(/\/informe\/([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("Falta el enlace.");
  expect(html).toContain("se muestra solo una vez");
  expect(html).toContain("Regenerar el informe invalida el enlace anterior");
  expect(html).toContain(
    whatsappShareLink(
      PRIVATE.phoneE164,
      `Hola Ana, aquí está el informe del servicio de tu bicicleta en Vector Bikes: ${SITE}/informe/${token}`,
    ),
  );
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html.match(/<h1[ >]/g)).toHaveLength(1);
  const sections =
    "Bicicleta|Trabajo realizado|Problemas encontrados|Componentes reemplazados|Antes y después|Recomendaciones|Próximas revisiones|Trabajos rechazados|Total".split(
      "|",
    );
  const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]);
  expect(headings.slice(-9)).toEqual(sections);
  expect(html).toContain("$25.000");
  expect(html.match(/<img /g)).toHaveLength(4);
  const getHtml = await (await render()).text();
  expect(getHtml).not.toContain(token);
  expect(getHtml).not.toContain(hashShareToken(token));
  expect(getHtml).toContain("Regenerar informe");
});

it("la página muestra los errores de validación y estado con role alert", async () => {
  const invalid = await render({ ...INPUT, recommendations: "x".repeat(2001) });
  expect(invalid.status).toBe(422);
  expect(await invalid.text()).toContain('aria-invalid="true" aria-describedby="form-error"');
  await test.db.execute(
    sql`update work_orders set status = 'en_reparacion' where id = ${order.id}`,
  );
  const response = await render(INPUT);
  expect(response.status).toBe(409);
  expect(await response.text()).toContain(
    "El informe se genera cuando la orden está Lista para retirar o Entregada.",
  );
});
