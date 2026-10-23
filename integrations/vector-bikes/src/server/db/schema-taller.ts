import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { branches, createdAt, updatedAt, users } from "./schema.ts";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_audit_log_branch_created").on(t.branchId, t.createdAt),
    index("idx_audit_log_entity").on(t.entity, t.entityId),
  ],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    usualMaterials: text("usual_materials"),
    aftercare: text("aftercare"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_services_branch_name").on(t.branchId, t.name),
    check("services_estimated_minutes_check", sql`estimated_minutes > 0`),
  ],
);

export const servicePrices = pgTable(
  "service_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    bikeType: text("bike_type").notNull(),
    priceClp: integer("price_clp").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_service_prices_service_bike_type").on(t.serviceId, t.bikeType),
    check(
      "service_prices_bike_type_check",
      sql`bike_type in ('mtb', 'ruta', 'gravel', 'urbana', 'ebike')`,
    ),
    check("service_prices_price_clp_check", sql`price_clp >= 0`),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    rut: text("rut"),
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    discoveryChannel: text("discovery_channel"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_customers_rut").on(t.rut).where(sql`rut is not null`),
    index("idx_customers_branch_phone").on(t.branchId, t.phoneE164),
    index("idx_customers_branch_name").on(t.branchId, t.name),
    check(
      "customers_discovery_channel_check",
      sql`discovery_channel is null or discovery_channel in ('instagram', 'google', 'recomendacion', 'sitio_web', 'paso_por_el_taller', 'otro')`,
    ),
  ],
);

export const bikes = pgTable(
  "bikes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    year: integer("year"),
    bikeType: text("bike_type").notNull(),
    size: text("size"),
    color: text("color"),
    serialNumber: text("serial_number"),
    kmNoted: integer("km_noted"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_bikes_customer").on(t.customerId),
    index("idx_bikes_branch_serial").on(t.branchId, t.serialNumber),
    check("bikes_type_check", sql`bike_type in ('mtb', 'ruta', 'gravel', 'urbana', 'ebike')`),
    check("bikes_year_check", sql`year is null or (year >= 1980 and year <= 2100)`),
    check("bikes_km_noted_check", sql`km_noted is null or km_noted >= 0`),
  ],
);

export const tallerTables = [auditLog, services, servicePrices, customers, bikes] as const;
