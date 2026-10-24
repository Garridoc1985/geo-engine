import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bikes, customers, services } from "./schema-taller.ts";
import { bookings, branches, createdAt, instant, updatedAt, users } from "./schema.ts";

function branchReference() {
  return uuid("branch_id")
    .notNull()
    .references(() => branches.id, { onDelete: "restrict" });
}

function creatorReference() {
  return uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" });
}
export const workOrders = pgTable(
  "work_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    number: integer("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    bikeId: uuid("bike_id")
      .notNull()
      .references(() => bikes.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("reservada"),
    requestedService: text("requested_service").notNull(),
    diagnosis: text("diagnosis"),
    observations: text("observations"),
    notes: text("notes"),
    assignedMechanicId: uuid("assigned_mechanic_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    estimatedDeliveryDate: date("estimated_delivery_date", { mode: "string" }),
    deliveryDateConfirmedAt: instant("delivery_date_confirmed_at"),
    estimatedMinutes: integer("estimated_minutes").notNull().default(0),
    totalClp: integer("total_clp").notNull().default(0),
    paidClp: integer("paid_clp").notNull().default(0),
    qcApprovedAt: instant("qc_approved_at"),
    qcApprovedBy: uuid("qc_approved_by").references(() => users.id, { onDelete: "restrict" }),
    qcSelfChecked: boolean("qc_self_checked").notNull().default(false),
    warrantyOfOrderId: uuid("warranty_of_order_id").references((): AnyPgColumn => workOrders.id, {
      onDelete: "restrict",
    }),
    taxDocType: text("tax_doc_type"),
    taxDocNumber: text("tax_doc_number"),
    taxDocDate: date("tax_doc_date", { mode: "string" }),
    receivedAt: instant("received_at"),
    deliveredAt: instant("delivered_at"),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_work_orders_branch_number").on(t.branchId, t.number),
    uniqueIndex("uq_work_orders_booking").on(t.bookingId),
    index("idx_work_orders_branch_status").on(t.branchId, t.status),
    index("idx_work_orders_mechanic_status").on(t.assignedMechanicId, t.status),
    index("idx_work_orders_bike").on(t.bikeId),
    index("idx_work_orders_customer").on(t.customerId),
    index("idx_work_orders_branch_delivery_date").on(t.branchId, t.estimatedDeliveryDate),
    check("work_orders_number_check", sql`number >= 1`),
    check(
      "work_orders_status_check",
      sql`status in ('reservada', 'recibida', 'diagnostico', 'esperando_aprobacion', 'esperando_repuesto', 'en_reparacion', 'control_calidad', 'lista_para_retirar', 'entregada', 'cancelada', 'trabajo_rechazado')`,
    ),
    check(
      "work_orders_non_negative_check",
      sql`total_clp >= 0 and paid_clp >= 0 and estimated_minutes >= 0`,
    ),
    check("work_orders_delivered_paid_check", sql`status <> 'entregada' or paid_clp = total_clp`),
    check(
      "work_orders_qc_check",
      sql`status not in ('lista_para_retirar', 'entregada') or qc_approved_at is not null`,
    ),
    check(
      "work_orders_tax_doc_type_check",
      sql`tax_doc_type is null or tax_doc_type in ('boleta', 'factura')`,
    ),
  ],
);
export const workOrderStatusHistory = pgTable(
  "work_order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_work_order_status_history_order_created").on(t.workOrderId, t.createdAt)],
);
export const intakeChecks = pgTable(
  "intake_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    itemKey: text("item_key").notNull(),
    result: text("result").notNull(),
    note: text("note"),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_intake_checks_order_item").on(t.workOrderId, t.itemKey),
    check(
      "intake_checks_item_key_check",
      sql`item_key in ('frenos', 'cadena', 'transmision', 'ruedas', 'neumaticos', 'estado_general', 'problemas_visibles')`,
    ),
    check("intake_checks_result_check", sql`result in ('ok', 'revisar', 'malo')`),
  ],
);
export const intakeAccessories = pgTable(
  "intake_accessories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_intake_accessories_order").on(t.workOrderId)],
);
export const workOrderItems = pgTable(
  "work_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"servicio" | "repuesto">().notNull(),
    origin: text("origin").$type<"inicial" | "adicional">().notNull(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    approvalId: uuid("approval_id").references(() => workOrderApprovals.id, {
      onDelete: "restrict",
    }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceClp: integer("unit_price_clp").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull().default(0),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_work_order_items_order").on(t.workOrderId),
    check("work_order_items_kind_check", sql`kind in ('servicio', 'repuesto')`),
    check("work_order_items_origin_check", sql`origin in ('inicial', 'adicional')`),
    check("work_order_items_quantity_check", sql`quantity > 0`),
    check(
      "work_order_items_non_negative_check",
      sql`unit_price_clp >= 0 and estimated_minutes >= 0`,
    ),
  ],
);

export const orderPhotos = pgTable(
  "order_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    stage: text("stage").$type<"recepcion" | "reparacion" | "terminado">().notNull(),
    retentionClass: text("retention_class").$type<"recepcion_6m" | "permanente">().notNull(),
    fullKey: text("full_key").notNull(),
    thumbKey: text("thumb_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    fullPurgedAt: instant("full_purged_at"),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_order_photos_full_key").on(t.fullKey),
    uniqueIndex("uq_order_photos_thumb_key").on(t.thumbKey),
    index("idx_order_photos_order_stage").on(t.workOrderId, t.stage),
    index("idx_order_photos_retention_created").on(t.retentionClass, t.createdAt),
    check("order_photos_stage_check", sql`stage in ('recepcion', 'reparacion', 'terminado')`),
    check(
      "order_photos_retention_check",
      sql`(stage = 'recepcion' and retention_class = 'recepcion_6m') or (stage <> 'recepcion' and retention_class = 'permanente')`,
    ),
  ],
);

export const orderSignatures = pgTable(
  "order_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"recepcion" | "entrega">().notNull(),
    storageKey: text("storage_key").notNull(),
    signedByName: text("signed_by_name").notNull(),
    signedAt: instant("signed_at").notNull(),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_order_signatures_storage_key").on(t.storageKey),
    uniqueIndex("uq_order_signatures_order_kind").on(t.workOrderId, t.kind),
    index("idx_order_signatures_order").on(t.workOrderId),
    check("order_signatures_kind_check", sql`kind in ('recepcion', 'entrega')`),
  ],
);

export const workOrderApprovals = pgTable(
  "work_order_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    recommendation: text("recommendation").notNull(),
    priceClp: integer("price_clp").notNull(),
    tokenHash: text("token_hash").notNull(),
    decidedAt: instant("decided_at"),
    decision: text("decision").$type<"aprobado" | "rechazado">(),
    decidedIpHash: text("decided_ip_hash"),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_work_order_approvals_token_hash").on(t.tokenHash),
    index("idx_work_order_approvals_order").on(t.workOrderId),
    check("work_order_approvals_price_check", sql`price_clp > 0`),
    check(
      "work_order_approvals_decision_check",
      sql`(decided_at is null and decision is null) or (decided_at is not null and decision is not null and decision in ('aprobado', 'rechazado'))`,
    ),
  ],
);

export const qcChecks = pgTable(
  "qc_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    itemKey: text("item_key").notNull(),
    result: text("result").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    selfCheck: boolean("self_check").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_qc_checks_order_created").on(t.workOrderId, t.createdAt),
    check(
      "qc_checks_item_key_check",
      sql`item_key in ('frenos', 'cambios', 'ruedas', 'apriete', 'neumaticos', 'prueba_de_rodaje', 'limpieza')`,
    ),
    check("qc_checks_result_check", sql`result in ('ok', 'falla')`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"abono" | "final">().notNull(),
    method: text("method").$type<"transferencia" | "tarjeta" | "efectivo" | "otro">().notNull(),
    amountClp: integer("amount_clp").notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    receivedAt: instant("received_at").notNull(),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_payments_one_abono")
      .on(t.workOrderId)
      .where(sql`kind = 'abono' and voided_at is null`),
    index("idx_payments_branch_received").on(t.branchId, t.receivedAt),
    check("payments_kind_check", sql`kind in ('abono', 'final')`),
    check("payments_method_check", sql`method in ('transferencia', 'tarjeta', 'efectivo', 'otro')`),
    check("payments_amount_check", sql`amount_clp > 0`),
  ],
);

export const bikeComponents = pgTable(
  "bike_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: branchReference(),
    bikeId: uuid("bike_id")
      .notNull()
      .references(() => bikes.id, { onDelete: "restrict" }),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    workOrderItemId: uuid("work_order_item_id").references(() => workOrderItems.id, {
      onDelete: "restrict",
    }),
    componentType: text("component_type").notNull(),
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    serialNumber: text("serial_number"),
    installedAt: date("installed_at", { mode: "string" }).notNull(),
    priceClp: integer("price_clp").notNull().default(0),
    replacedAt: date("replaced_at", { mode: "string" }),
    replacedByComponentId: uuid("replaced_by_component_id").references(
      (): AnyPgColumn => bikeComponents.id,
      { onDelete: "restrict" },
    ),
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: creatorReference(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_bike_components_bike_installed").on(t.bikeId, t.installedAt),
    index("idx_bike_components_order").on(t.workOrderId),
    check("bike_components_price_check", sql`price_clp >= 0`),
    check(
      "bike_components_replaced_date_check",
      sql`replaced_at is null or replaced_at >= installed_at`,
    ),
  ],
);

export const orderTables = [
  workOrders,
  workOrderStatusHistory,
  intakeChecks,
  intakeAccessories,
  workOrderItems,
  orderPhotos,
  orderSignatures,
  workOrderApprovals,
  qcChecks,
  payments,
  bikeComponents,
] as const;
export type WorkOrder = typeof workOrders.$inferSelect;
