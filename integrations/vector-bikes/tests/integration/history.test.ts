import { randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { TIMEZONE } from "../../src/server/booking/rules.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { branches } from "../../src/server/db/schema.ts";
import { installComponent } from "../../src/server/taller/components.ts";
import { bikeTimeline, customerTimeline, sortTimeline } from "../../src/server/taller/history.ts";
import type { TimelineEvent } from "../../src/server/taller/history.ts";
import { generateReport } from "../../src/server/taller/reports.ts";
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
const { default: BikePage } = await import("../../src/pages/taller/bicicletas/[id].astro");
const { default: CustomerPage } = await import("../../src/pages/taller/clientes/[id].astro");
const FIRST = new Date("2026-07-01T13:00:00.000Z");
const WORK = new Date("2026-07-01T14:00:00.000Z");
const REJECTED = new Date("2026-07-01T17:00:00.000Z");
const DELIVERED = new Date("2026-07-01T22:00:00.000Z");
const SECOND = new Date("2026-10-08T12:00:00.000Z");
const REPORTED = new Date("2026-10-08T18:00:00.000Z");
const WARRANTY = new Date("2026-10-09T12:00:00.000Z");
const COMPONENT = { componentType: "Cadena", brand: "Shimano", model: "CN-HG54" };
let test: TestDb;
let owner: SessionUser;
let first: typeof workOrders.$inferSelect;
let second: typeof first;
let warranty: typeof first;

async function seedIdentity() {
  const branchId = randomUUID();
  owner = { id: randomUUID(), branchId, role: "owner", name: "Dueño", email: "owner@example.test" };
  const customerId = randomUUID();
  const bikeId = randomUUID();
  await test.db.execute(sql`insert into branches (id, name) values (${branchId}, 'Vitacura')`);
  await test.db.execute(sql`insert into users (id, branch_id, role, name, email, password_hash)
    values (${owner.id}, ${branchId}, 'owner', 'Dueño', ${owner.email}, 'hash')`);
  await test.db.execute(sql`insert into customers (id, branch_id, name, phone_e164)
    values (${customerId}, ${branchId}, 'Ana Pérez', '+56912345678')`);
  await test.db.execute(sql`insert into bikes (id, branch_id, customer_id, brand, model, bike_type)
    values (${bikeId}, ${branchId}, ${customerId}, 'Trek', 'Marlin', 'mtb')`);
  first = await createOrder({
    customerId,
    bikeId,
    number: 1,
    status: "entregada",
    createdAt: WORK,
    receivedAt: FIRST,
    deliveredAt: DELIVERED,
    totalClp: 25000,
    paidClp: 25000,
    qcApprovedAt: DELIVERED,
  });
}

async function seedVisits() {
  second = await createOrder({
    number: 2,
    status: "lista_para_retirar",
    createdAt: SECOND,
    qcApprovedAt: REPORTED,
  });
  const bikeId = randomUUID();
  await test.db.execute(sql`insert into bikes (id, branch_id, customer_id, brand, model, bike_type)
    values (${bikeId}, ${owner.branchId}, ${first.customerId}, 'Trek', 'Domane', 'ruta')`);
  warranty = await createOrder({
    number: 3,
    bikeId,
    createdAt: WARRANTY,
    warrantyOfOrderId: first.id,
    requestedService: "Revisar ajuste en garantía",
  });
}

async function createOrder(overrides: Partial<typeof workOrders.$inferInsert>) {
  const [row] = await test.db
    .insert(workOrders)
    .values({
      branchId: owner.branchId,
      number: 4,
      customerId: first?.customerId,
      bikeId: first?.bikeId,
      requestedService: "Mantención",
      createdBy: owner.id,
      createdAt: FIRST,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("Falta la orden.");
  return row;
}

async function seedLines(branchId = owner.branchId, orderId = first.id) {
  await test.db.execute(sql`insert into work_order_items
    (branch_id, work_order_id, kind, origin, description, quantity, unit_price_clp, created_by, created_at, voided_at) values
    (${branchId}, ${orderId}, 'servicio', 'inicial', 'Ajuste de frenos', 2, 12500, ${owner.id}, ${WORK}, null),
    (${branchId}, ${orderId}, 'servicio', 'inicial', 'Trabajo anulado', 2, 12500, ${owner.id}, ${WORK}, ${WORK})`);
}

async function seedApprovals(branchId = owner.branchId, orderId = first.id) {
  await test.db.execute(sql`insert into work_order_approvals
    (branch_id, work_order_id, description, recommendation, price_clp, token_hash, decision, decided_at, created_by, voided_at) values
    (${branchId}, ${orderId}, 'Cambio de neumático', 'Reemplazar pronto', 10000, ${randomUUID()}, 'rechazado', ${REJECTED}, ${owner.id}, null),
    (${branchId}, ${orderId}, 'Adicional anulado', 'Reemplazar pronto', 10000, ${randomUUID()}, 'rechazado', ${REJECTED}, ${owner.id}, ${WORK}),
    (${branchId}, ${orderId}, 'Adicional aprobado', 'Reemplazar pronto', 10000, ${randomUUID()}, 'aprobado', ${REJECTED}, ${owner.id}, null)`);
}

async function seedPayments(branchId = owner.branchId, orderId = first.id) {
  await test.db.execute(sql`insert into payments
    (branch_id, work_order_id, kind, method, amount_clp, received_by, received_at, voided_at) values
    (${branchId}, ${orderId}, 'abono', 'efectivo', 10000, ${owner.id}, ${WORK}, null),
    (${branchId}, ${orderId}, 'final', 'efectivo', 15000, ${owner.id}, ${DELIVERED}, null),
    (${branchId}, ${orderId}, 'final', 'efectivo', 999, ${owner.id}, ${WORK}, ${WORK})`);
}

async function seedComponents() {
  const previous = await installComponent(
    test.db,
    owner,
    first.id,
    { ...COMPONENT, installedAt: "2026-07-01" },
    FIRST,
  );
  if (!previous.ok) throw new Error("Falló la instalación.");
  const replacement = await installComponent(
    test.db,
    owner,
    second.id,
    {
      ...COMPONENT,
      model: "CN-M6100",
      replacesComponentId: previous.id,
      installedAt: "2026-10-08",
    },
    SECOND,
  );
  if (!replacement.ok) throw new Error("Falló el reemplazo.");
  await test.db.execute(sql`insert into bike_components
    (branch_id, bike_id, work_order_id, component_type, brand, model, installed_at, replaced_at, voided_at, created_by)
    values (${owner.branchId}, ${first.bikeId}, ${first.id}, 'Cadena', 'Shimano', 'Anulado', '2026-07-01', '2026-10-08', ${WORK}, ${owner.id})`);
}

beforeEach(async () => {
  test = await createTestDb();
  await seedIdentity();
  await seedVisits();
  await seedLines();
  await seedApprovals();
  await seedPayments();
  await seedComponents();
  const result = await generateReport(
    test.db,
    owner,
    second.id,
    { recommendations: "Lubricar", nextChecks: "Revisar en seis meses" },
    REPORTED,
  );
  if (!result.ok) throw new Error("Falló el informe.");
  holder.db = test.db;
  holder.user = owner;
  return () => test.close();
});

it("1: reúne dos visitas con trabajos, componentes, rechazos e informe, sin precios de líneas", async () => {
  const events = await bikeTimeline(test.db, owner, first.bikeId);
  expect(events.map((event) => event.kind)).toEqual(
    (
      "order_opened service_done component_installed approval_rejected " +
      "order_opened component_installed component_replaced report_generated"
    ).split(" "),
  );
  expect(events.filter((event) => event.kind === "order_opened")).toEqual(
    [first, second].map((order, index) => ({
      at: [FIRST, SECOND][index]?.toISOString(),
      kind: "order_opened",
      orderId: order.id,
      orderNumber: `OT-0000${index + 1}`,
      title: "Orden abierta",
      detail: "Mantención",
    })),
  );
  expect(events.find((event) => event.kind === "service_done")).toEqual({
    at: WORK.toISOString(),
    kind: "service_done",
    orderId: first.id,
    orderNumber: "OT-00001",
    title: "Ajuste de frenos",
    detail: "Cantidad: 2",
  });
  expect(events.at(-1)).toEqual({
    at: REPORTED.toISOString(),
    kind: "report_generated",
    orderId: second.id,
    orderNumber: "OT-00002",
    title: "Informe generado",
  });
  expect(JSON.stringify(events)).not.toMatch(/price|Price|12500|12\.500|Anulado|anulado|aprobado/);
  for (const event of events) {
    expect(event.orderId).toBeTruthy();
    expect(event.orderNumber).toMatch(/^OT-0000[12]$/);
    expect(event.at).toMatch(/Z$/);
  }
});

it("2: conserva instalación y reemplazo y convierte las fechas al mediodía local, verano e invierno", async () => {
  const events = await bikeTimeline(test.db, owner, first.bikeId);
  const previous = events.filter((event) => event.title === "Cadena Shimano CN-HG54");
  expect(previous.map((event) => [event.kind, event.at])).toEqual([
    ["component_installed", "2026-07-01T16:00:00.000Z"],
    ["component_replaced", "2026-10-08T15:00:00.000Z"],
  ]);
  for (const event of events.filter((event) => event.kind.startsWith("component_")))
    expect(DateTime.fromISO(event.at).setZone(TIMEZONE).toFormat("HH:mm")).toBe("12:00");
});

it("3: muestra el adicional rechazado con descripción, recomendación y fecha de decisión", async () => {
  const events = await bikeTimeline(test.db, owner, first.bikeId);
  expect(events.filter((event) => event.kind === "approval_rejected")).toEqual([
    {
      at: REJECTED.toISOString(),
      kind: "approval_rejected",
      orderId: first.id,
      orderNumber: "OT-00001",
      title: "Cambio de neumático",
      detail: "Reemplazar pronto",
    },
  ]);
});

it("4: reúne visitas, pagos vigentes, entrega y garantía con el número de la orden original", async () => {
  const events = await customerTimeline(test.db, owner, first.customerId);
  expect(events.map((event) => event.kind)).toEqual(
    (
      "order_opened payment payment order_delivered " + "order_opened order_opened warranty_opened"
    ).split(" "),
  );
  expect(
    events.filter((event) => event.kind === "payment").map((event) => [event.title, event.detail]),
  ).toEqual([
    ["Abono", "$10.000"],
    ["Pago final", "$15.000"],
  ]);
  expect(events.find((event) => event.kind === "order_delivered")).toMatchObject({
    at: DELIVERED.toISOString(),
    orderId: first.id,
    orderNumber: "OT-00001",
  });
  expect(events.at(-1)).toEqual({
    at: WARRANTY.toISOString(),
    kind: "warranty_opened",
    orderId: warranty.id,
    orderNumber: "OT-00003",
    title: "Garantía abierta",
    detail: "Garantía de OT-00001",
  });
});

it("5: ordena por instante y prioridad fija, sin mutación y conservando el orden en empates completos", () => {
  const kinds: TimelineEvent["kind"][] = [
    "order_opened",
    "service_done",
    "component_installed",
    "component_replaced",
    "approval_rejected",
    "payment",
    "order_delivered",
    "report_generated",
    "warranty_opened",
  ];
  const events: TimelineEvent[] = [...kinds].reverse().map((kind) => ({
    at: "2026-10-08T12:00:00.000Z",
    kind,
    title: kind,
  }));
  const tied: TimelineEvent = {
    at: "2026-10-08T09:00:00-03:00",
    kind: "payment",
    title: "Segundo pago",
  };
  const earlier: TimelineEvent = {
    at: FIRST.toISOString(),
    kind: "report_generated",
    title: "Anterior",
  };
  events.push(tied, earlier);
  const before = [...events];
  events.forEach(Object.freeze);
  Object.freeze(events);
  const sorted = sortTimeline(events);
  expect(events).toEqual(before);
  expect(sorted).not.toBe(events);
  expect(sorted).toEqual([
    earlier,
    ...kinds.flatMap((kind) => before.filter((event) => event !== earlier && event.kind === kind)),
  ]);
  expect(sorted.filter((event) => event.kind === "payment").map((event) => event.title)).toEqual([
    "payment",
    "Segundo pago",
  ]);
});

it("excluye órdenes anuladas y todos sus eventos asociados", async () => {
  await test.db.update(workOrders).set({ voidedAt: WARRANTY }).where(eq(workOrders.id, first.id));
  const bikeEvents = await bikeTimeline(test.db, owner, first.bikeId);
  expect(bikeEvents.map((event) => event.kind)).toEqual([
    "order_opened",
    "component_installed",
    "report_generated",
  ]);
  const customerEvents = await customerTimeline(test.db, owner, first.customerId);
  expect(customerEvents.some((event) => event.orderId === first.id)).toBe(false);
  expect(customerEvents.at(-1)?.detail).toBe("Garantía de OT-00001");
  await test.db.update(workOrders).set({ voidedAt: WARRANTY }).where(eq(workOrders.id, second.id));
  expect(await bikeTimeline(test.db, owner, first.bikeId)).toEqual([]);
});

it("filtra cada tabla por sucursal aunque sus relaciones apunten a una visita local", async () => {
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal.");
  const beforeBike = await bikeTimeline(test.db, owner, first.bikeId);
  const beforeCustomer = await customerTimeline(test.db, owner, first.customerId);
  await createOrder({ number: 5, branchId: branch.id });
  await seedLines(branch.id);
  await seedApprovals(branch.id);
  await seedPayments(branch.id, second.id);
  await test.db.execute(sql`insert into bike_components
    (branch_id, bike_id, work_order_id, component_type, brand, model, installed_at, created_by)
    values (${branch.id}, ${first.bikeId}, ${first.id}, 'Cadena', 'Shimano', 'CN-HG54', '2026-07-01', ${owner.id})`);
  await test.db.execute(sql`insert into service_reports
    (branch_id, work_order_id, generated_at, generated_by, snapshot, share_token_hash)
    values (${branch.id}, ${first.id}, ${REPORTED}, ${owner.id}, '{}', ${randomUUID()})`);
  expect(await bikeTimeline(test.db, owner, first.bikeId)).toEqual(beforeBike);
  expect(await customerTimeline(test.db, owner, first.customerId)).toEqual(beforeCustomer);
  const outsider = { ...owner, branchId: branch.id };
  expect(await bikeTimeline(test.db, outsider, first.bikeId)).toEqual([]);
  expect(await customerTimeline(test.db, outsider, first.customerId)).toEqual([]);
});

it("mecánico, ids inválidos y fichas inexistentes no obtienen historial", async () => {
  const mechanic = { ...owner, role: "mechanic" as const };
  expect(await bikeTimeline(test.db, mechanic, first.bikeId)).toEqual([]);
  expect(await customerTimeline(test.db, mechanic, first.customerId)).toEqual([]);
  for (const id of [randomUUID(), "inválido"]) {
    expect(await bikeTimeline(test.db, owner, id)).toEqual([]);
    expect(await customerTimeline(test.db, owner, id)).toEqual([]);
  }
});

it("las fichas muestran Historial ordenado con fecha local, enlaces, título y detalle", async () => {
  const container = await AstroContainer.create({
    astroConfig: { site: "https://vectorbikes.cl" },
  });
  for (const [page, path, id] of [
    [BikePage, "bicicletas", first.bikeId],
    [CustomerPage, "clientes", first.customerId],
  ] as const) {
    const html = await container.renderToString(page, {
      request: new Request(`https://vectorbikes.cl/taller/${path}/${id}`),
      params: { id },
    });
    const history = html.slice(html.indexOf('<section aria-labelledby="history-heading">'));
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(history).toContain('<h2 id="history-heading">Historial</h2>');
    expect(history).toContain("<ol>");
    expect(history).toContain(`href="/taller/ordenes/${first.id}"`);
    expect(history).toContain("OT-00001");
    expect(history).toContain('class="tabular-nums">01-07-2026</time>');
    expect(history).toContain("Orden abierta");
    expect(history).toContain("Mantención");
  }
});

it("las fichas sin visitas muestran el estado vacío", async () => {
  await test.db.update(workOrders).set({ voidedAt: WARRANTY });
  const container = await AstroContainer.create({
    astroConfig: { site: "https://vectorbikes.cl" },
  });
  for (const [page, id] of [
    [BikePage, first.bikeId],
    [CustomerPage, first.customerId],
  ] as const) {
    const html = await container.renderToString(page, { params: { id } });
    expect(html).toContain("Sin historial todavía.");
  }
});
