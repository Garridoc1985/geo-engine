import { createHmac } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { getHashEnv, getSiteEnv, getTurnstileEnv } from "../../lib/env.ts";
import { errorMessage, log } from "../../lib/log.ts";
import { readRange } from "../booking/availability.ts";
import { createBooking } from "../booking/create-booking.ts";
import { DAILY_CAPACITY, TIMEZONE } from "../booking/rules.ts";
import { addDays, computeDay, localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";
import { type Booking, bookingRequests } from "../db/schema.ts";
import { verifyTurnstile } from "./turnstile.ts";

export type HandlerContext = {
  db: AppDb;
  now: Date;
  ip: string | null;
  fetchFn?: typeof fetch;
  onCreated?: (booking: Booking, cancelToken: string) => Promise<void>;
};

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_MINUTES = 10;

const MESSAGES = {
  validation: "Revisa los datos del formulario.",
  turnstile: "No pudimos verificar que eres una persona. Vuelve a intentar.",
  slot: "El bloque ya no está disponible",
  phone:
    "Ya tienes una reserva próxima con este teléfono. Cancélala desde tu correo para reservar otra.",
  rate: "Demasiados intentos desde tu conexión. Vuelve a intentar en 10 minutos.",
  internal: "Algo falló de nuestro lado. Vuelve a intentar en unos minutos.",
} as const;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  error: string,
  fields?: Record<string, string>,
  headers?: Record<string, string>,
): Response {
  return jsonResponse(status, fields ? { error, code, fields } : { error, code }, headers);
}

/** Origins aceptados: el de `PUBLIC_SITE_URL` y su variante con y sin `www.`, mismo esquema y puerto. */
function allowedOrigins(siteUrl: string): string[] {
  const site = new URL(siteUrl);
  const bare = site.hostname.replace(/^www\./, "");
  return [bare, `www.${bare}`].map((hostname) => {
    const variant = new URL(site.origin);
    variant.hostname = hostname;
    return variant.origin;
  });
}

/**
 * Todo POST con efecto exige `Origin` igual al origin de `PUBLIC_SITE_URL`,
 * o al mismo origin con o sin `www.` (el esquema y el puerto deben coincidir).
 * `security.checkOrigin` de Astro está desactivado por el proxy de Replit; esta es la defensa CSRF.
 */
export function isAllowedOrigin(
  request: Request,
  siteUrl: string = getSiteEnv().PUBLIC_SITE_URL,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") {
    return false;
  }
  try {
    return allowedOrigins(siteUrl).includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Solo el origen (esquema, host y puerto) del `Origin` recibido, nunca la ruta ni la consulta:
 * sirve para ver qué mandan los navegadores y visores de correo reales, sin datos personales.
 */
export function originForLog(request: Request): string {
  const origin = request.headers.get("origin");
  if (!origin) {
    return "ausente";
  }
  if (origin === "null") {
    return "null";
  }
  try {
    return new URL(origin).origin;
  } catch {
    return "no-valido";
  }
}

/** La IP nunca se guarda en claro. */
export function hashIp(ip: string | null): string | null {
  if (ip === null) {
    return null;
  }
  return createHmac("sha256", getHashEnv().SESSION_SECRET).update(ip).digest("hex");
}

/** `569XXXXXXXX` u `9XXXXXXXX` → `+569XXXXXXXX`; cualquier otra forma es inválida. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("569")) {
    return `+${digits}`;
  }
  if (digits.length === 9 && digits.startsWith("9")) {
    return `+56${digits}`;
  }
  return null;
}

function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "formulario");
    fields[key] ??= issue.message;
  }
  return fields;
}

const availabilitySchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elige un día."),
  dias: z.coerce
    .number()
    .int("Pide entre 1 y 31 días.")
    .min(1, "Pide entre 1 y 31 días.")
    .max(31, "Pide entre 1 y 31 días.")
    .default(14),
  modo: z.enum(["taller", "retiro"], "Elige taller o retiro.").default("taller"),
});

const bookingSchema = z
  .strictObject({
    mode: z.enum(["taller", "retiro"], "Elige cómo nos entregas la bici."),
    service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elige un día."),
    start: z.string().regex(/^\d{2}:(00|30)$/, "Elige un bloque."),
    nombre: z.string().trim().min(2, "Escribe tu nombre.").max(80, "Escribe tu nombre."),
    telefono: z
      .string()
      .refine(
        (value) => normalizePhone(value) !== null,
        "Faltan dígitos: son 8 después del +56 9.",
      ),
    correo: z
      .email("Escribe un correo válido, por ejemplo nombre@correo.cl.")
      .max(254, "Escribe un correo válido, por ejemplo nombre@correo.cl."),
    bicicleta: z
      .string()
      .trim()
      .min(2, "Cuéntanos la marca y el tipo de bici.")
      .max(120, "Cuéntanos la marca y el tipo de bici."),
    descripcion: z
      .string()
      .trim()
      .min(5, "Cuéntanos qué necesita tu bici.")
      .max(1000, "Cuéntanos qué necesita tu bici."),
    comuna: z.enum(["Vitacura", "Las Condes"], "Elige Vitacura o Las Condes.").nullish(),
    direccion: z.string().trim().min(5).max(200).nullish(),
    consentimiento: z.literal(true, "Acepta el aviso de privacidad para confirmar."),
    whatsapp_consentimiento: z.boolean().default(false),
    turnstile_token: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const isPickup = value.mode === "retiro";
    if (isPickup && !value.comuna) {
      ctx.addIssue({ code: "custom", path: ["comuna"], message: "Elige Vitacura o Las Condes." });
    }
    if (isPickup && !value.direccion) {
      ctx.addIssue({
        code: "custom",
        path: ["direccion"],
        message: "Escribe la dirección de retiro.",
      });
    }
    if (!isPickup && value.comuna) {
      ctx.addIssue({ code: "custom", path: ["comuna"], message: "Elige Vitacura o Las Condes." });
    }
    if (!isPickup && value.direccion) {
      ctx.addIssue({
        code: "custom",
        path: ["direccion"],
        message: "Escribe la dirección de retiro.",
      });
    }
  });

export async function handleAvailability(url: URL, ctx: HandlerContext): Promise<Response> {
  const parsed = availabilitySchema.safeParse({
    desde: url.searchParams.get("desde") ?? undefined,
    dias: url.searchParams.get("dias") ?? undefined,
    modo: url.searchParams.get("modo") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse(422, "validation_error", MESSAGES.validation, fieldsOf(parsed.error));
  }
  const { desde, dias, modo } = parsed.data;
  if (desde < localToday(ctx.now)) {
    return errorResponse(422, "validation_error", MESSAGES.validation, {
      desde: "Elige una fecha de hoy en adelante.",
    });
  }

  const dates = Array.from({ length: dias }, (_, index) => addDays(desde, index));
  const last = dates.at(-1) ?? desde;
  const dayData = await readRange(ctx.db, desde, last);

  const days = dates.map((date) =>
    computeDay({ date, mode: modo, now: ctx.now, ...dayData(date) }),
  );

  return jsonResponse(200, { timezone: TIMEZONE, modo, capacity: DAILY_CAPACITY, days });
}

function rateLimitKey(ctx: HandlerContext): string | null {
  return hashIp(ctx.ip) ?? hashIp("sin-ip-conocida");
}

/** Devuelve la respuesta 429 cuando la IP se pasó del límite; no registra nada. */
export async function checkRateLimit(ctx: HandlerContext): Promise<Response | null> {
  const ipHash = rateLimitKey(ctx);
  if (ipHash === null) {
    return null;
  }
  const since = new Date(ctx.now.getTime() - RATE_LIMIT_MINUTES * 60_000);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.ipHash, ipHash), gt(bookingRequests.createdAt, since)));
  if (Number(row?.n ?? 0) >= RATE_LIMIT_MAX) {
    return errorResponse(429, "rate_limited", MESSAGES.rate, undefined, {
      "Retry-After": String(RATE_LIMIT_MINUTES * 60),
    });
  }
  return null;
}

/** Registra el intento; solo cuentan los que pasaron la validación (un 422 no suma). */
export async function recordAttempt(ctx: HandlerContext): Promise<void> {
  const ipHash = rateLimitKey(ctx);
  if (ipHash !== null) {
    await ctx.db.insert(bookingRequests).values({ ipHash, createdAt: ctx.now });
  }
}

function localHhmm(instant: Date): string {
  return DateTime.fromJSDate(instant).setZone(TIMEZONE).toFormat("HH:mm");
}

export async function handleCreateBooking(
  request: Request,
  ctx: HandlerContext,
): Promise<Response> {
  try {
    const limited = await checkRateLimit(ctx);
    if (limited) {
      return limited;
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorResponse(422, "validation_error", MESSAGES.validation, {
        formulario: "No pudimos leer el formulario.",
      });
    }
    const parsed = bookingSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(422, "validation_error", MESSAGES.validation, fieldsOf(parsed.error));
    }
    const data = parsed.data;
    const phone = normalizePhone(data.telefono);
    if (phone === null) {
      return errorResponse(422, "validation_error", MESSAGES.validation, {
        telefono: "Faltan dígitos: son 8 después del +56 9.",
      });
    }
    await recordAttempt(ctx);

    const token = data.turnstile_token ?? "";
    const human =
      token.length > 0 &&
      (await verifyTurnstile({
        token,
        ip: ctx.ip,
        secret: getTurnstileEnv().TURNSTILE_SECRET_KEY,
        fetchFn: ctx.fetchFn,
      }));
    if (!human) {
      return errorResponse(403, "turnstile_failed", MESSAGES.turnstile);
    }

    const result = await createBooking(
      ctx.db,
      {
        mode: data.mode,
        serviceDate: data.service_date,
        start: data.start,
        customerName: data.nombre,
        phoneE164: phone,
        email: data.correo.toLowerCase(),
        bike: data.bicicleta,
        description: data.descripcion,
        comuna: data.comuna ?? null,
        address: data.direccion ?? null,
        ipHash: hashIp(ctx.ip),
        whatsappConsent: data.whatsapp_consentimiento,
      },
      ctx.now,
    );
    if (!result.ok) {
      const message = result.code === "phone_limit" ? MESSAGES.phone : MESSAGES.slot;
      return errorResponse(409, result.code, message);
    }

    const { booking } = result;
    try {
      await ctx.onCreated?.(booking, result.cancelToken);
    } catch (error) {
      log.error("email.failed", { code: booking.code, message: errorMessage(error) });
    }

    return jsonResponse(201, {
      code: booking.code,
      service_date: booking.serviceDate,
      start: localHhmm(booking.startsAt),
      end: localHhmm(booking.endsAt),
      mode: booking.mode,
      fee: booking.pickupFeeClp,
    });
  } catch (error) {
    log.error("reservas.internal_error", { message: errorMessage(error) });
    return errorResponse(500, "internal_error", MESSAGES.internal);
  }
}
