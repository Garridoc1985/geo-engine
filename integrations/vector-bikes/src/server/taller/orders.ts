import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { workOrders, workOrderStatusHistory } from "../db/schema-orders.ts";
import { bikes, customers } from "../db/schema-taller.ts";
import { bookings } from "../db/schema.ts";
import { recordAudit } from "./audit.ts";
import { bikeFormSchema, insertBike, listBikesOfCustomer } from "./bikes.ts";
import { customerFormSchema, findCustomerByPhone, insertCustomer } from "./customers.ts";
import { isAllowedTransition, TAX_DOC_TYPES } from "./rules.ts";
import type { OrderStatus } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export function formatOrderNumber(n: number): string {
  return `OT-${String(n).padStart(5, "0")}`;
}

export async function allocateOrderNumber(db: AppDb, branchId: string): Promise<number> {
  const result = (await db.execute(sql`
    update branches set next_order_number = next_order_number + 1
    where id = ${branchId} returning next_order_number - 1 as number
  `)) as unknown as { number: number }[] | { rows: { number: number }[] };
  // postgres-js devuelve un arreglo; PGlite devuelve { rows }.
  const [row] = Array.isArray(result) ? result : result.rows;
  if (!row) throw new Error("No se encontró la sucursal para numerar la orden.");
  return row.number;
}

type StatusChange = {
  branchId: string;
  orderId: string;
  from: OrderStatus | null;
  to: OrderStatus;
  actorUserId: string | null;
  note?: string;
};

export async function recordStatusChange(db: AppDb, change: StatusChange, now: Date) {
  if (change.from !== null && !isAllowedTransition(change.from, change.to)) {
    return { ok: false, code: "invalid_transition" } as const;
  }
  await db.insert(workOrderStatusHistory).values({
    branchId: change.branchId,
    workOrderId: change.orderId,
    fromStatus: change.from,
    toStatus: change.to,
    actorUserId: change.actorUserId,
    note: change.note ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true } as const;
}

export async function prefillFromBooking(db: AppDb, actor: SessionUser, bookingId: string) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!booking) return null;
  const customer = await findCustomerByPhone(db, actor, booking.phoneE164);
  const [brand = "", ...model] = booking.bike.trim().split(/\s+/);
  return {
    booking,
    existingCustomer: customer
      ? {
          id: customer.id,
          name: customer.name,
          bikes: await listBikesOfCustomer(db, actor, customer.id),
        }
      : null,
    prefill: {
      name: booking.customerName,
      phoneE164: booking.phoneE164,
      email: booking.email,
      brand,
      model: model.join(" "),
      requestedService: booking.description,
    },
  };
}

export const startReceptionSchema = z
  .object({
    bookingId: z.uuid({ error: "Selecciona una reserva válida." }).nullable().default(null),
    customerId: z.uuid({ error: "Selecciona un cliente válido." }).nullable().default(null),
    customer: customerFormSchema.optional(),
    bikeId: z.uuid({ error: "Selecciona una bicicleta válida." }).nullable().default(null),
    bike: bikeFormSchema.optional(),
    requestedService: z
      .string({ error: "Ingresa el servicio solicitado." })
      .trim()
      .min(1, "Ingresa el servicio solicitado.")
      .max(2000, "El servicio solicitado no puede superar los 2000 caracteres."),
  })
  .refine((input) => Boolean(input.customerId) !== Boolean(input.customer), {
    path: ["customerId"],
    message: "Selecciona un cliente o ingresa uno nuevo.",
  })
  .refine((input) => Boolean(input.bikeId) !== Boolean(input.bike), {
    path: ["bikeId"],
    message: "Selecciona una bicicleta o ingresa una nueva.",
  });

type ReceptionInput = z.infer<typeof startReceptionSchema>;
type ReceptionFailure =
  | { ok: false; code: "forbidden" | "booking_taken" | "not_found" | "validation_error" }
  | { ok: false; code: "duplicate"; existing: { id: string; name: string } | null };
type ReceptionResult = { ok: true; orderId: string; number: number } | ReceptionFailure;

class ReceptionError extends Error {
  result: ReceptionFailure;
  constructor(result: ReceptionFailure) {
    super("No se pudo iniciar la recepción.");
    this.result = result;
  }
}

async function requireAvailableBooking(db: AppDb, actor: SessionUser, bookingId: string | null) {
  if (bookingId === null) return;
  const [booking] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .for("update");
  if (!booking) throw new ReceptionError({ ok: false, code: "booking_taken" });
  const [order] = await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.bookingId, bookingId)))
    .limit(1);
  if (order) throw new ReceptionError({ ok: false, code: "booking_taken" });
}

async function receptionCustomer(db: AppDb, actor: SessionUser, input: ReceptionInput, now: Date) {
  if (input.customerId !== null) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.branchId, actor.branchId), eq(customers.id, input.customerId)))
      .limit(1);
    if (!customer) throw new ReceptionError({ ok: false, code: "not_found" });
    return customer;
  }
  if (!input.customer) throw new ReceptionError({ ok: false, code: "validation_error" });
  const result = await insertCustomer(db, actor.branchId, input.customer, now);
  if (!result.ok) throw new ReceptionError(result);
  return result.customer;
}

async function receptionBike(
  db: AppDb,
  actor: SessionUser,
  customerId: string,
  input: ReceptionInput,
  now: Date,
) {
  if (input.bikeId !== null) {
    const [bike] = await db
      .select()
      .from(bikes)
      .where(
        and(
          eq(bikes.branchId, actor.branchId),
          eq(bikes.customerId, customerId),
          eq(bikes.id, input.bikeId),
        ),
      )
      .limit(1);
    if (!bike) throw new ReceptionError({ ok: false, code: "not_found" });
    return bike;
  }
  if (!input.bike) throw new ReceptionError({ ok: false, code: "validation_error" });
  const result = await insertBike(db, actor.branchId, customerId, input.bike, now);
  if (!result.ok) throw new ReceptionError(result);
  return result.bike;
}

async function insertReceptionOrder(
  db: AppDb,
  actor: SessionUser,
  input: ReceptionInput,
  now: Date,
) {
  await requireAvailableBooking(db, actor, input.bookingId);
  const customer = await receptionCustomer(db, actor, input, now);
  const bike = await receptionBike(db, actor, customer.id, input, now);
  const number = await allocateOrderNumber(db, actor.branchId);
  const [order] = await db
    .insert(workOrders)
    .values({
      branchId: actor.branchId,
      number,
      customerId: customer.id,
      bikeId: bike.id,
      bookingId: input.bookingId,
      status: "reservada",
      requestedService: input.requestedService,
      createdBy: actor.id,
      assignedMechanicId: actor.role === "mechanic" ? actor.id : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: workOrders.bookingId })
    .returning();
  if (!order) throw new ReceptionError({ ok: false, code: "booking_taken" });
  return order;
}

export async function startReception(
  db: AppDb,
  actor: SessionUser,
  input: unknown,
  now: Date,
): Promise<ReceptionResult> {
  if (!can(actor.role, "reception.perform")) return { ok: false, code: "forbidden" };
  const parsed = startReceptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" };
  try {
    return await db.transaction(async (tx) => {
      const order = await insertReceptionOrder(tx, actor, parsed.data, now);
      await recordStatusChange(
        tx,
        {
          branchId: actor.branchId,
          orderId: order.id,
          from: null,
          to: "reservada",
          actorUserId: actor.id,
        },
        now,
      );
      await recordAudit(
        tx,
        {
          branchId: actor.branchId,
          actorUserId: actor.id,
          action: "order.created",
          entity: "work_order",
          entityId: order.id,
          details: { number: order.number },
        },
        now,
      );
      return { ok: true, orderId: order.id, number: order.number } as const;
    });
  } catch (error) {
    if (error instanceof ReceptionError) return error.result;
    throw error;
  }
}

export async function getOrderHeader(db: AppDb, actor: SessionUser, id: string) {
  const [header] = await db
    .select({ order: workOrders, customer: customers, bike: bikes })
    .from(workOrders)
    .innerJoin(
      customers,
      and(eq(customers.id, workOrders.customerId), eq(customers.branchId, actor.branchId)),
    )
    .innerJoin(bikes, and(eq(bikes.id, workOrders.bikeId), eq(bikes.branchId, actor.branchId)))
    .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, id)))
    .limit(1);
  return header ?? null;
}

export const taxDocSchema = z.strictObject({
  type: z.enum(TAX_DOC_TYPES),
  number: z.string().trim().min(1).max(30),
  date: z.iso.date(),
});

export async function updateTaxDocument(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  input: unknown,
  now: Date,
) {
  if (!can(actor.role, "tax_doc.edit")) return { ok: false, code: "forbidden" } as const;
  const parsed = taxDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)))
      .for("update");
    if (!order || order.voidedAt) return { ok: false, code: "not_found" } as const;
    if (!canAccessOrder(actor, order)) return { ok: false, code: "forbidden" } as const;
    const { type, number, date } = parsed.data;
    await tx
      .update(workOrders)
      .set({ taxDocType: type, taxDocNumber: number, taxDocDate: date, updatedAt: now })
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, orderId)));
    await recordAudit(
      tx,
      {
        branchId: actor.branchId,
        actorUserId: actor.id,
        action: "order.tax_document",
        entity: "work_order",
        entityId: orderId,
        details: { type, number, date },
      },
      now,
    );
    return { ok: true } as const;
  });
}

async function recordWarrantyOpening(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  originalNumber: number,
  now: Date,
) {
  const author = { branchId: actor.branchId, actorUserId: actor.id };
  await recordStatusChange(db, { ...author, orderId, from: null, to: "reservada" }, now);
  await recordAudit(
    db,
    {
      ...author,
      action: "order.warranty_opened",
      entity: "work_order",
      entityId: orderId,
      details: { originalNumber },
    },
    now,
  );
}

export async function openWarrantyOrder(
  db: AppDb,
  actor: SessionUser,
  originalId: string,
  input: { reason: string },
  now: Date,
) {
  if (!can(actor.role, "warranty.open")) return { ok: false, code: "forbidden" } as const;
  const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.branchId, actor.branchId), eq(workOrders.id, originalId)))
      .for("update");
    if (!original || original.voidedAt) return { ok: false, code: "not_found" } as const;
    if (original.status !== "entregada") return { ok: false, code: "not_delivered" } as const;
    const number = await allocateOrderNumber(tx, actor.branchId);
    const [order] = await tx
      .insert(workOrders)
      .values({
        branchId: actor.branchId,
        number,
        customerId: original.customerId,
        bikeId: original.bikeId,
        warrantyOfOrderId: originalId,
        status: "reservada",
        requestedService: `Garantía de ${formatOrderNumber(original.number)}: ${parsed.data.reason}`,
        createdBy: actor.id,
        assignedMechanicId: actor.role === "mechanic" ? actor.id : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!order) throw new Error("No se pudo crear la orden de garantía.");
    await recordWarrantyOpening(tx, actor, order.id, original.number, now);
    return { ok: true, orderId: order.id } as const;
  });
}
