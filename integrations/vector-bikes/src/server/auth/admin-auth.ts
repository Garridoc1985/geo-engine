import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../db/client.ts";
import { adminSessions, branches, loginAttempts, users } from "../db/schema.ts";
import { can } from "./permissions.ts";
import type { Role } from "./permissions.ts";

export const SESSION_COOKIE = "vb_admin_session";
export const SESSION_DAYS = 7;

const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const HASH_PREFIX = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** `scrypt$16384$8$1$<sal base64>$<hash base64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return `${HASH_PREFIX}${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Formato inválido → `false`; nunca lanza. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(HASH_PREFIX)) {
    return false;
  }
  const [saltB64, hashB64, ...rest] = stored.slice(HASH_PREFIX.length).split("$");
  if (!saltB64 || !hashB64 || rest.length > 0) {
    return false;
  }
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length !== KEY_LENGTH) {
    return false;
  }
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), KEY_LENGTH, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** Hash de una clave que nadie conoce: iguala el tiempo de respuesta para correos inexistentes. */
let dummyHash: string | undefined;
function getDummyHash(): string {
  dummyHash ??= `${HASH_PREFIX}${randomBytes(SALT_BYTES).toString("base64")}$${randomBytes(KEY_LENGTH).toString("base64")}`;
  return dummyHash;
}

/** Incluso un hash mal formado paga exactamente una verificación scrypt en el login. */
async function loginPasswordMatches(password: string, stored?: string): Promise<boolean> {
  const [salt, hash, ...rest] = stored?.slice(HASH_PREFIX.length).split("$") ?? [];
  const valid = !!(
    stored?.startsWith(HASH_PREFIX) &&
    salt &&
    hash &&
    rest.length === 0 &&
    Buffer.from(hash, "base64").length === KEY_LENGTH
  );
  const matches = await verifyPassword(password, valid && stored ? stored : getDummyHash());
  return valid && matches;
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  branchId: string;
};

async function createOwner(db: AppDb, email: string, passwordHash: string, now: Date) {
  const [branch] = await db.select({ id: branches.id }).from(branches).limit(1);
  const [created] = branch
    ? []
    : await db
        .insert(branches)
        .values({ name: "Vitacura", createdAt: now, updatedAt: now })
        .returning({ id: branches.id });
  const selected = branch ?? created;
  if (!selected) {
    throw new Error("No se pudo crear la sucursal");
  }
  const [user] = await db
    .insert(users)
    .values({
      branchId: selected.id,
      email,
      passwordHash,
      name: email.split("@")[0] ?? email,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!user) {
    throw new Error("No se pudo crear el usuario");
  }
  return user;
}

export async function revokeUserSessions(db: AppDb, userId: string, now: Date): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt)));
}

/** Crea o actualiza el usuario y revoca todas sus sesiones abiertas. */
export async function setAdminPassword(
  db: AppDb,
  email: string,
  password: string,
  now: Date,
): Promise<"created" | "updated"> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres");
  }
  const normalized = normalizeEmail(email);
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .for("update");
    if (!existing) {
      await createOwner(tx, normalized, passwordHash, now);
      return "created";
    }
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, existing.id));
    await revokeUserSessions(tx, existing.id, now);
    return "updated";
  });
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; role: Role }
  | { ok: false; code: "invalid" | "rate_limited" };

async function recentFailures(db: AppDb, ipHash: string, email: string, now: Date) {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MINUTES * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ipHash, ipHash),
        eq(loginAttempts.email, email),
        gt(loginAttempts.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Rate limit antes de la clave; correo inexistente igual paga un scrypt. */
export async function loginAdmin(
  db: AppDb,
  args: { email: string; password: string; ipHash: string; now: Date },
): Promise<LoginResult> {
  const email = normalizeEmail(args.email);
  const { ipHash, now } = args;
  if ((await recentFailures(db, ipHash, email, now)) >= LOGIN_MAX_FAILURES) {
    return { ok: false, code: "rate_limited" };
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const matches = await loginPasswordMatches(args.password, user?.passwordHash);
  if (!user || !matches || !user.isActive) {
    await db.insert(loginAttempts).values({ ipHash, email, createdAt: now });
    return { ok: false, code: "invalid" };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
  await db.insert(adminSessions).values({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, token, expiresAt, role: user.role as Role };
}

/** Un token de sesión mide 43 caracteres base64url; lo demás no llega a la base. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

/** `null` si no hay sesión vigente: falta, no existe, revocada o expirada. */
export async function requireAdmin(
  db: AppDb,
  token: string | undefined,
  now: Date,
): Promise<SessionUser | null> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    return null;
  }
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      branchId: users.branchId,
    })
    .from(adminSessions)
    .innerJoin(users, eq(users.id, adminSessions.userId))
    .where(
      and(
        eq(adminSessions.tokenHash, hashSessionToken(parsed.data)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return row ? { ...row, role: row.role as Role } : null;
}

export function safeNextPath(raw: unknown): string | null {
  return typeof raw === "string" &&
    raw.length <= 512 &&
    (raw === "/admin" || raw === "/taller" || /^\/(taller|admin)[/?#]/.test(raw)) &&
    !raw.includes("//")
    ? raw
    : null;
}

export function loginRedirect(path: string): string {
  return `/admin/login?next=${encodeURIComponent(path)}`;
}

export function defaultLanding(role: Role): string {
  return can(role, "admin.panel") ? "/admin" : "/taller";
}

export async function logoutAdmin(db: AppDb, token: string | undefined, now: Date): Promise<void> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    return;
  }
  await db
    .update(adminSessions)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(adminSessions.tokenHash, hashSessionToken(parsed.data)),
        isNull(adminSessions.revokedAt),
      ),
    );
}

export function sessionCookieOptions(siteUrl: string): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/** Formulario de `/admin/login`; los límites evitan un scrypt sobre entradas gigantes. */
export const loginFormSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});
