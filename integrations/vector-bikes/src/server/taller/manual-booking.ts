import { and, asc, between, eq, getTableColumns, inArray } from "drizzle-orm";
import { z } from "zod";
import { log } from "../../lib/log.ts";
import { normalizePhone } from "../api/handlers.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import { readRange } from "../booking/availability.ts";
import { createBooking } from "../booking/create-booking.ts";
import type { BookingMode } from "../booking/rules.ts";
import { addDays, computeDay } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { workOrders } from "../db/schema-orders.ts";
import { bookings } from "../db/schema.ts";
import { notifyBookingCreated } from "../email/notifications.ts";

export const manualBookingSchema = z
  .strictObject({
    mode: z.enum(["taller", "retiro"], "Elige taller o retiro."),
    service_date: z.iso.date("Elige una fecha válida."),
    start: z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|30)$/, "Elige un bloque."),
    nombre: z.string().trim().min(2, "Escribe el nombre.").max(80, "Máximo 80 caracteres."),
    telefono: z
      .string()
      .refine(
        (value) => normalizePhone(value) !== null,
        "Faltan dígitos: son 8 después del +56 9.",
      ),
    correo: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.email("Escribe un correo válido.").max(254, "Máximo 254 caracteres.").optional(),
    ),
    bicicleta: z
      .string()
      .trim()
      .min(2, "Indica la marca y el tipo de bici.")
      .max(120, "Máximo 120 caracteres."),
    descripcion: z
      .string()
      .trim()
      .min(5, "Indica qué necesita la bici.")
      .max(1000, "Máximo 1000 caracteres."),
    comuna: z.enum(["Vitacura", "Las Condes"], "Elige Vitacura o Las Condes.").nullish(),
    direccion: z
      .string()
      .trim()
      .min(5, "Escribe la dirección de retiro.")
      .max(200, "Máximo 200 caracteres.")
      .nullish(),
    source: z.enum(["telefono", "whatsapp", "presencial"], "Elige el origen de la reserva."),
    consentimiento: z.literal(true, "Confirma que el cliente aceptó el aviso de privacidad."),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "retiro") {
      if (!value.comuna)
        ctx.addIssue({ code: "custom", path: ["comuna"], message: "Elige Vitacura o Las Condes." });
      if (!value.direccion)
        ctx.addIssue({
          code: "custom",
          path: ["direccion"],
          message: "Escribe la dirección de retiro.",
        });
    } else {
      if (value.comuna)
        ctx.addIssue({
          code: "custom",
          path: ["comuna"],
          message: "La comuna solo corresponde a un retiro.",
        });
      if (value.direccion)
        ctx.addIssue({
          code: "custom",
          path: ["direccion"],
          message: "La dirección solo corresponde a un retiro.",
        });
    }
  });

export type ManualBookingInput = z.infer<typeof manualBookingSchema>;
type ManualBookingDeps = { notify?: typeof notifyBookingCreated };

export async function createManualBooking(
  db: AppDb,
  actor: SessionUser,
  input: unknown,
  now: Date,
  deps: ManualBookingDeps = {},
) {
  if (!can(actor.role, "bookings.manage")) return { ok: false, code: "forbidden" } as const;
  const parsed = manualBookingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "validation_error" } as const;
  const data = parsed.data;
  const phone = normalizePhone(data.telefono);
  if (phone === null) return { ok: false, code: "validation_error" } as const;
  const result = await createBooking(
    db,
    {
      mode: data.mode,
      serviceDate: data.service_date,
      start: data.start,
      customerName: data.nombre,
      phoneE164: phone,
      email: data.correo?.toLowerCase() ?? null,
      bike: data.bicicleta,
      description: data.descripcion,
      comuna: data.comuna ?? null,
      address: data.direccion ?? null,
      ipHash: null,
      whatsappConsent: false,
      source: data.source,
    },
    now,
  );
  if (result.ok) {
    try {
      await (deps.notify ?? notifyBookingCreated)(result.booking, result.cancelToken);
    } catch {
      log.error("email.failed", { kind: "manual_booking", code: result.booking.code });
    }
  }
  return result;
}

// bookings es la agenda única de la sucursal; no tiene branch_id.
export function listUpcomingBookings(db: AppDb, today: string, days = 14) {
  return db
    .select({
      ...getTableColumns(bookings),
      orderId: workOrders.id,
      orderNumber: workOrders.number,
    })
    .from(bookings)
    .leftJoin(workOrders, eq(workOrders.bookingId, bookings.id))
    .where(
      and(
        between(bookings.serviceDate, today, addDays(today, days - 1)),
        inArray(bookings.status, ["confirmed", "ready_for_pickup"]),
      ),
    )
    .orderBy(asc(bookings.serviceDate), asc(bookings.startsAt), asc(bookings.id));
}

export async function freeBlocks(db: AppDb, date: string, mode: BookingMode, now: Date) {
  const dayData = await readRange(db, date, date);
  return computeDay({ date, mode, now, ...dayData(date) }).blocks.filter(
    (block) => block.state === "free",
  );
}
