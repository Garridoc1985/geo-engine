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
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const instant = (name: string) => timestamp(name, { withTimezone: true });
export const createdAt = () => instant("created_at").notNull().defaultNow();
export const updatedAt = () =>
  instant("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("web"),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    timezone: text("timezone").notNull().default("America/Santiago"),
    customerName: text("customer_name").notNull(),
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    bike: text("bike").notNull(),
    description: text("description").notNull(),
    comuna: text("comuna"),
    address: text("address"),
    pickupFeeClp: integer("pickup_fee_clp").notNull().default(0),
    consentAt: instant("consent_at").notNull(),
    whatsappConsentAt: instant("whatsapp_consent_at"),
    cancelTokenHash: text("cancel_token_hash").notNull(),
    cancelTokenUsedAt: instant("cancel_token_used_at"),
    cancelledAt: instant("cancelled_at"),
    cancelledBy: text("cancelled_by"),
    completedAt: instant("completed_at"),
    reminderSentAt: instant("reminder_sent_at"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_bookings_code").on(t.code),
    uniqueIndex("uq_bookings_cancel_token_hash").on(t.cancelTokenHash),
    index("idx_bookings_service_date_status").on(t.serviceDate, t.status),
    index("idx_bookings_phone_status_starts_at").on(t.phoneE164, t.status, t.startsAt),
    index("idx_bookings_reminder").on(t.serviceDate, t.status, t.reminderSentAt),
    check("bookings_mode_check", sql`mode in ('taller', 'retiro')`),
    check("bookings_source_check", sql`source in ('web', 'telefono', 'whatsapp', 'presencial')`),
    check(
      "bookings_status_check",
      sql`status in ('confirmed', 'ready_for_pickup', 'cancelled', 'completed', 'no_show')`,
    ),
    check(
      "bookings_cancelled_by_check",
      sql`cancelled_by is null or cancelled_by in ('customer', 'admin')`,
    ),
    check(
      "bookings_fee_check",
      sql`(mode = 'taller' and pickup_fee_clp = 0) or (mode = 'retiro' and pickup_fee_clp = 15000)`,
    ),
    check(
      "bookings_retiro_address_check",
      sql`mode = 'taller' or (comuna in ('Vitacura', 'Las Condes') and address is not null)`,
    ),
    check("bookings_time_order_check", sql`ends_at > starts_at`),
  ],
);

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    metaMessageId: text("meta_message_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: instant("claimed_at"),
    sentAt: instant("sent_at"),
    reconciledAt: instant("reconciled_at"),
    reconciliationNote: text("reconciliation_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_whatsapp_booking_type").on(t.bookingId, t.type),
    index("idx_whatsapp_status").on(t.status),
    check("whatsapp_message_type_check", sql`type in ('reminder', 'ready')`),
    check(
      "whatsapp_message_status_check",
      sql`status in ('pending', 'sending', 'sent', 'failed', 'unknown')`,
    ),
  ],
);

export const bookingBlocks = pgTable(
  "booking_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    blockStart: time("block_start").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_booking_blocks_active_slot")
      .on(t.serviceDate, t.blockStart)
      .where(sql`is_active = true`),
    index("idx_booking_blocks_booking_id").on(t.bookingId),
  ],
);

export const bookingDays = pgTable("booking_days", {
  serviceDate: date("service_date", { mode: "string" }).primaryKey(),
  createdAt: createdAt(),
});

export const blockedPeriods = pgTable(
  "blocked_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_blocked_periods_service_date").on(t.serviceDate),
    check(
      "blocked_periods_range_check",
      sql`(start_time is null and end_time is null) or (start_time is not null and end_time is not null and start_time < end_time)`,
    ),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    nextOrderNumber: integer("next_order_number").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_branches_name").on(t.name),
    check("branches_next_order_number_check", sql`next_order_number >= 1`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_users_email").on(t.email),
    index("idx_users_branch_role").on(t.branchId, t.role),
    check("users_role_check", sql`role in ('owner', 'admin', 'reception', 'mechanic')`),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    revokedAt: instant("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("uq_admin_sessions_token_hash").on(t.tokenHash),
    index("idx_admin_sessions_user_id").on(t.userId),
  ],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: text("ip_hash").notNull(),
    email: text("email").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_login_attempts_ip_email_created").on(t.ipHash, t.email, t.createdAt)],
);

export const bookingRequests = pgTable(
  "booking_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: text("ip_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_booking_requests_ip_created").on(t.ipHash, t.createdAt)],
);

export const allTables = [
  bookings,
  bookingBlocks,
  bookingDays,
  blockedPeriods,
  adminSessions,
  loginAttempts,
  bookingRequests,
  whatsappMessages,
  branches,
  users,
] as const;

export type Booking = typeof bookings.$inferSelect;
export type BlockedPeriod = typeof blockedPeriods.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type User = typeof users.$inferSelect;
