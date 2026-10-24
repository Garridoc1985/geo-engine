import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import { workOrders } from "../../src/server/db/schema-orders.ts";
import { bikes, customers } from "../../src/server/db/schema-taller.ts";
import { branches, users } from "../../src/server/db/schema.ts";
import {
  buildLabel,
  escapeHtml,
  qrPayload,
  renderLabelHtml,
} from "../../src/server/taller/label.ts";
import { searchTaller } from "../../src/server/taller/search.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const SITE_URL = "https://vectorbikes.cl";
const NOW = new Date("2026-10-07T15:00:00.000Z");
let test: TestDb;
let owner: SessionUser;
let mechanic: SessionUser;
let otherMechanic: SessionUser;
let orderId: string;
let customerId: string;

async function actor(branchId: string, role: SessionUser["role"]): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: "Personal de prueba",
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba.");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function seedOrder() {
  const [customer] = await test.db
    .insert(customers)
    .values({ branchId: owner.branchId, name: "Ana Pérez", phoneE164: "+56912345678" })
    .returning();
  if (!customer) throw new Error("Falta el cliente de prueba.");
  customerId = customer.id;
  const [bike] = await test.db
    .insert(bikes)
    .values({
      branchId: owner.branchId,
      customerId,
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
      customerId,
      bikeId: bike.id,
      status: "recibida",
      requestedService: "Mantención",
      assignedMechanicId: mechanic.id,
      estimatedDeliveryDate: "2026-10-09",
      createdBy: owner.id,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  if (!order) throw new Error("Falta la orden de prueba.");
  orderId = order.id;
}

beforeEach(async () => {
  test = await createTestDb();
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  owner = await actor(branch.id, "owner");
  mechanic = await actor(branch.id, "mechanic");
  otherMechanic = await actor(branch.id, "mechanic");
  await seedOrder();
  return () => test.close();
});

it("1: entrega la URL exacta de la orden al generador QR inyectado", async () => {
  const received: string[] = [];
  const toSvg = async (text: string) => {
    received.push(text);
    return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  };
  const expected = `${SITE_URL}/taller/ordenes/${orderId}`;
  expect(qrPayload(SITE_URL, orderId)).toBe(expected);
  expect(qrPayload(`${SITE_URL}/`, orderId)).toBe(expected);
  const result = await buildLabel(test.db, owner, orderId, `${SITE_URL}/`, { toSvg });
  expect(result.ok).toBe(true);
  expect(received).toEqual([expected]);
});

it("2: genera HTML con número, cliente, fecha, SVG, ancho de 62 mm y URL del QR", async () => {
  const result = await buildLabel(test.db, owner, orderId, SITE_URL);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("No se generó la etiqueta.");
  for (const text of [
    '<html lang="es-CL">',
    "OT-00001",
    "Ana Pérez",
    "Entrega estimada: 09-10-2026",
    "<svg",
    "@page { size: 62mm auto; margin: 0; }",
    `data-qr-url="${SITE_URL}/taller/ordenes/${orderId}"`,
    'onclick="window.print()">Imprimir</button>',
    "@media print { button { display: none; } }",
  ]) {
    expect(result.html).toContain(text);
  }
});

it("3: escapa el nombre del cliente <b>Ana</b> en la etiqueta", async () => {
  await test.db.update(customers).set({ name: "<b>Ana</b>" }).where(eq(customers.id, customerId));
  const result = await buildLabel(test.db, owner, orderId, SITE_URL);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("No se generó la etiqueta.");
  expect(result.html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
  expect(result.html).not.toContain("<b>Ana</b>");
});

it.each(["OT-00001", "ot1", "1"])("4: encuentra la orden número 1 buscando %s", async (q) => {
  const expected = {
    customers: [],
    orders: [{ id: orderId, number: 1, label: "OT-00001", status: "recibida" }],
  };
  expect(await searchTaller(test.db, owner, q)).toEqual(expected);
  expect(await searchTaller(test.db, mechanic, q)).toEqual(expected);
});

it("un mecánico no encuentra una orden asignada a otro mecánico", async () => {
  for (const q of ["OT-00001", "ot1", "1"]) {
    expect(await searchTaller(test.db, otherMechanic, q)).toEqual({ customers: [], orders: [] });
  }
});

it("rechaza la etiqueta sin acceso y no llama al generador QR", async () => {
  const toSvg = vi.fn(async () => "<svg></svg>");
  expect(await buildLabel(test.db, otherMechanic, orderId, SITE_URL, { toSvg })).toEqual({
    ok: false,
    code: "forbidden",
  });
  expect(toSvg).not.toHaveBeenCalled();
});

it("no encuentra ni genera etiquetas de órdenes inexistentes o de otra sucursal", async () => {
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba.");
  const outsider = await actor(branch.id, "owner");
  const toSvg = vi.fn(async () => "<svg></svg>");
  for (const [user, id] of [
    [owner, randomUUID()],
    [outsider, orderId],
  ] as const) {
    expect(await buildLabel(test.db, user, id, SITE_URL, { toSvg })).toEqual({
      ok: false,
      code: "not_found",
    });
  }
  expect(await searchTaller(test.db, outsider, "OT-00001")).toEqual({ customers: [], orders: [] });
  expect(toSvg).not.toHaveBeenCalled();
});

it("omite órdenes anuladas en las etiquetas y en la búsqueda", async () => {
  await test.db.update(workOrders).set({ voidedAt: NOW }).where(eq(workOrders.id, orderId));
  const toSvg = vi.fn(async () => "<svg></svg>");
  expect(await buildLabel(test.db, owner, orderId, SITE_URL, { toSvg })).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await searchTaller(test.db, owner, "1")).toEqual({ customers: [], orders: [] });
  expect(toSvg).not.toHaveBeenCalled();
});

it("un mecánico encuentra y etiqueta una orden sin asignar en recepción", async () => {
  await test.db
    .update(workOrders)
    .set({ assignedMechanicId: null, estimatedDeliveryDate: null })
    .where(eq(workOrders.id, orderId));
  expect((await searchTaller(test.db, otherMechanic, "1")).orders).toHaveLength(1);
  const result = await buildLabel(test.db, otherMechanic, orderId, SITE_URL);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("No se generó la etiqueta.");
  expect(result.html).toContain("Entrega estimada: sin fecha");
});

it("escapa los cinco caracteres HTML y la URL en el atributo del QR", () => {
  expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  const html = renderLabelHtml({
    number: 1,
    customerName: 'Ana & "Pérez"',
    estimatedDate: null,
    qrUrl: 'https://vectorbikes.cl/?a=1&b="<test>"',
    svg: "<svg></svg>",
  });
  expect(html).toContain("Ana &amp; &quot;Pérez&quot;");
  expect(html).toContain(
    'data-qr-url="https://vectorbikes.cl/?a=1&amp;b=&quot;&lt;test&gt;&quot;"',
  );
});
