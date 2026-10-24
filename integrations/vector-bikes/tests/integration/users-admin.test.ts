import { randomUUID } from "node:crypto";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword, loginAdmin, requireAdmin } from "../../src/server/auth/admin-auth.ts";
import type { SessionUser } from "../../src/server/auth/admin-auth.ts";
import type { Role } from "../../src/server/auth/permissions.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { auditLog } from "../../src/server/db/schema-taller.ts";
import { adminSessions, branches, users } from "../../src/server/db/schema.ts";
import { listAudit, recordAudit, redactDetails } from "../../src/server/taller/audit.ts";
import {
  changeUserRole,
  createUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  userCreateSchema,
} from "../../src/server/taller/users.ts";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

const holder = vi.hoisted(() => ({ db: null as AppDb | null }));
vi.mock("../../src/server/db/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/db/client.ts")>()),
  getDb: () => {
    if (!holder.db) throw new Error("Base de prueba no inicializada");
    return holder.db;
  },
}));
const { default: UsersPage } = await import("../../src/pages/taller/usuarios.astro");

const NOW = new Date("2026-10-05T15:00:00.000Z");
const LATER = new Date("2026-10-05T15:01:00.000Z");
const PASSWORD = "clave-inicial-de-prueba";
const NEW_PASSWORD = "otra-clave-larga-de-prueba";
const SITE = "https://vectorbikes.cl";
let test: TestDb;
let owner: SessionUser;

async function seedUser(branchId: string, role: Role): Promise<SessionUser> {
  const [user] = await test.db
    .insert(users)
    .values({
      branchId,
      role,
      name: `Usuario ${role}`,
      email: `${randomUUID()}@ejemplo.cl`,
      passwordHash: await hashPassword(PASSWORD),
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  if (!user) throw new Error("Falta el usuario de prueba");
  return { id: user.id, branchId, role, name: user.name, email: user.email };
}

async function mechanic() {
  const input = userCreateSchema.parse({
    name: "Mecánico de prueba",
    email: "mecanico@ejemplo.cl",
    role: "mechanic",
    password: PASSWORD,
  });
  const result = await createUser(test.db, owner, input, NOW);
  if (!result.ok) throw new Error(`No se creó el usuario: ${result.code}`);
  return { input, id: result.userId };
}

async function login(email: string, password = PASSWORD) {
  const result = await loginAdmin(test.db, { email, password, ipHash: "a".repeat(64), now: NOW });
  if (!result.ok) throw new Error(`No se inició sesión: ${result.code}`);
  return result.token;
}

function attempt(email: string, password: string, now = LATER) {
  return loginAdmin(test.db, { email, password, ipHash: "b".repeat(64), now });
}

async function render(token?: string, data?: Record<string, string>, origin = SITE) {
  const headers: Record<string, string> = token ? { cookie: `vb_admin_session=${token}` } : {};
  if (data) {
    headers.origin = origin;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const request = new Request(`${SITE}/taller/usuarios`, {
    method: data ? "POST" : "GET",
    headers,
    body: data ? new URLSearchParams(data) : undefined,
  });
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  vi.useFakeTimers({ toFake: ["Date"], now: LATER }); // la sesión de NOW dura 7 días
  return container.renderToResponse(UsersPage, { request }).finally(() => vi.useRealTimers());
}

beforeEach(async () => {
  test = await createTestDb();
  holder.db = test.db;
  const [branch] = await test.db.insert(branches).values({ name: "Vitacura" }).returning();
  if (!branch) throw new Error("Falta la sucursal de prueba");
  owner = await seedUser(branch.id, "owner");
  return async () => {
    holder.db = null;
    await test.close();
  };
});

it("1: crea un mecánico activo en la sucursal del dueño y permite loginAdmin", async () => {
  const { input, id } = await mechanic();
  const [created] = await test.db.select().from(users).where(eq(users.id, id));
  expect(created).toMatchObject({
    branchId: owner.branchId,
    createdBy: owner.id,
    isActive: true,
    name: input.name,
    role: "mechanic",
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(created?.passwordHash).not.toBe(PASSWORD);
  const result = await attempt(input.email, input.password, NOW);
  expect(result).toMatchObject({ ok: true, role: "mechanic" });
  if (!result.ok) throw new Error("El mecánico no pudo ingresar");
  expect(await requireAdmin(test.db, result.token, NOW)).toMatchObject({ id, role: "mechanic" });
});

it("2: rechaza createUser para admin sin insertar usuarios ni auditoría", async () => {
  const admin = await seedUser(owner.branchId, "admin");
  const before = await test.db.select().from(users);
  const input = userCreateSchema.parse({
    name: "Sin permiso",
    email: "prohibido@ejemplo.cl",
    role: "mechanic",
    password: PASSWORD,
  });
  expect(await createUser(test.db, admin, input, NOW)).toEqual({ ok: false, code: "forbidden" });
  expect(await test.db.select().from(users)).toEqual(before);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("3: desactivar revoca todas las sesiones del usuario y conserva las del dueño", async () => {
  const { id, input } = await mechanic();
  const tokens = [await login(input.email), await login(input.email)];
  const ownerToken = await login(owner.email);
  expect(await setUserActive(test.db, owner, id, false, LATER)).toEqual({ ok: true, userId: id });
  for (const token of tokens) expect(await requireAdmin(test.db, token, LATER)).toBeNull();
  const sessions = await test.db.select().from(adminSessions).where(eq(adminSessions.userId, id));
  expect(sessions).toHaveLength(2);
  expect(sessions.every((session) => session.revokedAt?.getTime() === LATER.getTime())).toBe(true);
  expect(await requireAdmin(test.db, ownerToken, LATER)).toMatchObject({ id: owner.id });
  expect(await attempt(input.email, PASSWORD)).toEqual({ ok: false, code: "invalid" });
});

it("3: restablecer clave revoca todas las sesiones y permite ingresar con la nueva", async () => {
  const { id, input } = await mechanic();
  const tokens = [await login(input.email), await login(input.email)];
  const ownerToken = await login(owner.email);
  expect(await resetUserPassword(test.db, owner, id, NEW_PASSWORD, LATER)).toEqual({
    ok: true,
    userId: id,
  });
  for (const token of tokens) expect(await requireAdmin(test.db, token, LATER)).toBeNull();
  const sessions = await test.db.select().from(adminSessions).where(eq(adminSessions.userId, id));
  expect(sessions.every((session) => session.revokedAt?.getTime() === LATER.getTime())).toBe(true);
  expect(await requireAdmin(test.db, ownerToken, LATER)).toMatchObject({ id: owner.id });
  expect(await attempt(input.email, PASSWORD)).toEqual({ ok: false, code: "invalid" });
  expect(await attempt(input.email, NEW_PASSWORD)).toMatchObject({ ok: true, role: "mechanic" });
});

it("4: rechaza desactivarse, cambiar su propio rol y restablecer su propia clave", async () => {
  const before = await test.db.select().from(users);
  expect(await setUserActive(test.db, owner, owner.id, false, NOW)).toEqual({
    ok: false,
    code: "self_change",
  });
  expect(await changeUserRole(test.db, owner, owner.id, "mechanic", NOW)).toEqual({
    ok: false,
    code: "self_change",
  });
  expect(await resetUserPassword(test.db, owner, owner.id, NEW_PASSWORD, NOW)).toEqual({
    ok: false,
    code: "self_change",
  });
  expect(await test.db.select().from(users)).toEqual(before);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("5: audita creación, desactivación, activación, rol y clave sin datos sensibles", async () => {
  const { id, input } = await mechanic();
  await setUserActive(test.db, owner, id, false, LATER);
  await setUserActive(test.db, owner, id, true, LATER);
  await changeUserRole(test.db, owner, id, "reception", LATER);
  await resetUserPassword(test.db, owner, id, NEW_PASSWORD, LATER);
  const rows = await test.db.select().from(auditLog);
  expect(rows).toHaveLength(5);
  expect(rows.map((row) => row.action).sort()).toEqual(
    [
      "user.created",
      "user.deactivated",
      "user.activated",
      "user.role_changed",
      "user.password_reset",
    ].sort(),
  );
  for (const row of rows) {
    expect(row).toMatchObject({
      branchId: owner.branchId,
      actorUserId: owner.id,
      entity: "users",
      entityId: id,
    });
    expect(Object.keys(row.details).sort()).toEqual(["previousRole", "role"]);
    for (const secret of [input.email, owner.email, PASSWORD, NEW_PASSWORD]) {
      expect(JSON.stringify(row.details)).not.toContain(secret);
    }
  }
  expect(rows.find((row) => row.action === "user.role_changed")?.details).toEqual({
    role: "reception",
    previousRole: "mechanic",
  });
  expect((await listAudit(test.db, owner.branchId, 1))[0]).toMatchObject({
    actorName: owner.name,
  });
});

it("normaliza el correo y revierte una creación duplicada sin auditoría adicional", async () => {
  const { input } = await mechanic();
  const duplicate = userCreateSchema.parse({ ...input, email: "  MECANICO@EJEMPLO.CL  " });
  expect(await createUser(test.db, owner, duplicate, LATER)).toEqual({
    ok: false,
    code: "email_taken",
  });
  expect(await test.db.select().from(users)).toHaveLength(2);
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it("comprueba el permiso en todas las operaciones y no cambia filas", async () => {
  const { id } = await mechanic();
  const actor = await seedUser(owner.branchId, "admin");
  const before = await test.db.select().from(users);
  for (const result of [
    await listUsers(test.db, actor),
    await setUserActive(test.db, actor, id, false, NOW),
    await changeUserRole(test.db, actor, id, "owner", NOW),
    await resetUserPassword(test.db, actor, id, NEW_PASSWORD, NOW),
  ])
    expect(result).toEqual({ ok: false, code: "forbidden" });
  expect(await test.db.select().from(users)).toEqual(before);
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it("protege al último dueño activo incluso con un actor de sesión anterior", async () => {
  const other = await seedUser(owner.branchId, "owner");
  await test.db
    .update(users)
    .set({ isActive: false, updatedAt: NOW })
    .where(eq(users.id, owner.id));
  expect(await setUserActive(test.db, owner, other.id, false, NOW)).toEqual({
    ok: false,
    code: "last_owner",
  });
  expect(await changeUserRole(test.db, owner, other.id, "admin", NOW)).toEqual({
    ok: false,
    code: "last_owner",
  });
  expect(await test.db.select().from(auditLog)).toEqual([]);
  const [remaining] = await test.db.select().from(users).where(eq(users.id, other.id));
  expect(remaining).toMatchObject({ role: "owner", isActive: true });
});

it("aísla usuarios, cambios y auditoría entre sucursales", async () => {
  const [branch] = await test.db.insert(branches).values({ name: "Otra sucursal" }).returning();
  if (!branch) throw new Error("Falta la sucursal");
  const other = await seedUser(branch.id, "owner");
  const before = await test.db.select().from(users);
  expect(await setUserActive(test.db, owner, other.id, false, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await changeUserRole(test.db, owner, other.id, "mechanic", NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await resetUserPassword(test.db, owner, other.id, NEW_PASSWORD, NOW)).toEqual({
    ok: false,
    code: "not_found",
  });
  await recordAudit(
    test.db,
    {
      branchId: branch.id,
      actorUserId: null,
      action: "approval.decided",
      entity: "approvals",
      entityId: null,
      details: {},
    },
    NOW,
  );
  expect(await listUsers(test.db, owner)).toMatchObject({ ok: true, users: [{ id: owner.id }] });
  expect(await listAudit(test.db, owner.branchId)).toEqual([]);
  expect((await listAudit(test.db, branch.id))[0]).toMatchObject({ actorName: null });
  expect(await test.db.select().from(users)).toEqual(before);
});

it("redacta claves sensibles en objetos y arreglos anidados sin mutar el original", async () => {
  const keys = ["EMAIL", "correo", "phone", "telefono", "rut", "sessionToken", "password", "clave"];
  const safe = [1, null, { role: "owner" }];
  const nested = { ...Object.fromEntries(keys.map((key) => [key, "privado"])), safe };
  const details = { role: "mechanic", nested: [nested] };
  const redacted = { ...Object.fromEntries(keys.map((key) => [key, "[redactado]"])), safe };
  expect(redactDetails(details)).toEqual({ role: "mechanic", nested: [redacted] });
  expect(Object.values(nested)).toContain("privado");
  await test.db.transaction((tx) =>
    recordAudit(
      tx,
      {
        branchId: owner.branchId,
        actorUserId: owner.id,
        action: "user.created",
        entity: "users",
        entityId: owner.id,
        details,
      },
      NOW,
    ),
  );
  expect((await listAudit(test.db, owner.branchId))[0]?.details).toEqual({
    role: "mechanic",
    nested: [redacted],
  });
});

it("revierte la clave y la revocación si falla la auditoría dentro de la transacción", async () => {
  const { id, input } = await mechanic();
  const token = await login(input.email);
  const before = await test.db.select().from(users).where(eq(users.id, id));
  await expect(
    resetUserPassword(test.db, { ...owner, id: randomUUID() }, id, NEW_PASSWORD, LATER),
  ).rejects.toThrow();
  expect(await test.db.select().from(users).where(eq(users.id, id))).toEqual(before);
  expect(await requireAdmin(test.db, token, LATER)).toMatchObject({ id });
  expect(await test.db.select().from(auditLog)).toHaveLength(1);
});

it("redirige sin sesión y devuelve 403 al mecánico", async () => {
  const anonymous = await render();
  expect(anonymous.status).toBe(303);
  expect(anonymous.headers.get("cache-control")).toBe("no-store");
  expect(anonymous.headers.get("location")).toBe("/admin/login?next=%2Ftaller%2Fusuarios");
  const { input } = await mechanic();
  expect((await render(await login(input.email))).status).toBe(403);
});

it("rechaza el origen del POST antes de cambiar usuarios", async () => {
  const token = await login(owner.email);
  const response = await render(token, { accion: "crear" }, "https://otro.cl");
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await test.db.select().from(users)).toHaveLength(1);
  expect(await test.db.select().from(auditLog)).toEqual([]);
});

it("muestra errores en español, vinculados a los campos, sin devolver la clave", async () => {
  const response = await render(await login(owner.email), {
    accion: "crear",
    name: "X",
    email: "invalido",
    role: "mechanic",
    password: "secreto-corto",
  });
  expect(response.status).toBe(422);
  const html = await response.text();
  expect(html).toContain("Ingresa un nombre de 2 a 80 caracteres.");
  expect(html).toContain('aria-describedby="create-name-error"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).not.toContain('value="secreto-corto"');
  expect(await test.db.select().from(users)).toHaveLength(1);
});

it("crea por POST, redirige 303 y muestra tabla y auditoría sin caché", async () => {
  const token = await login(owner.email);
  const response = await render(token, {
    accion: "crear",
    name: "Mecánico nuevo",
    email: "nuevo@ejemplo.cl",
    role: "mechanic",
    password: PASSWORD,
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/taller/usuarios?hecho=crear");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const page = await render(token);
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  expect(html).toContain("Mecánico nuevo");
  expect(html).toContain("Registro de auditoría");
  expect(html).toContain("Restablecer clave");
});
