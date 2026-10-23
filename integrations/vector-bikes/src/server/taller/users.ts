import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, revokeUserSessions } from "../auth/admin-auth.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can, ROLES } from "../auth/permissions.ts";
import type { Role } from "../auth/permissions.ts";
import { isUniqueViolation } from "../db/client.ts";
import type { AppDb } from "../db/client.ts";
import { branches, users } from "../db/schema.ts";
import type { User } from "../db/schema.ts";
import { recordAudit } from "./audit.ts";
import type { AuditAction } from "./audit.ts";

export const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(ROLES),
  password: z.string().min(12).max(1024),
});

type UserResult =
  | { ok: true; userId: string }
  | { ok: false; code: "forbidden" | "self_change" | "email_taken" | "last_owner" | "not_found" };
type UserChanges = Pick<Partial<User>, "role" | "isActive" | "passwordHash">;

export async function listUsers(db: AppDb, actor: SessionUser) {
  if (!can(actor.role, "users.manage")) return { ok: false, code: "forbidden" } as const;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.branchId, actor.branchId))
    .orderBy(asc(users.name), asc(users.id));
  return { ok: true, users: rows } as const;
}

/** Serializa la comprobación del último dueño, incluso al modificar filas distintas. */
async function lockBranch(db: AppDb, branchId: string): Promise<void> {
  await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, branchId))
    .for("update");
}

async function auditUser(
  db: AppDb,
  actor: SessionUser,
  userId: string,
  action: AuditAction,
  role: string,
  previousRole: string | null,
  now: Date,
) {
  await recordAudit(
    db,
    {
      branchId: actor.branchId,
      actorUserId: actor.id,
      action,
      entity: "users",
      entityId: userId,
      details: { role, previousRole },
    },
    now,
  );
}

export async function createUser(
  db: AppDb,
  actor: SessionUser,
  input: z.infer<typeof userCreateSchema>,
  now: Date,
): Promise<UserResult> {
  if (!can(actor.role, "users.manage")) return { ok: false, code: "forbidden" };
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      await lockBranch(tx, actor.branchId);
      const [created] = await tx
        .insert(users)
        .values({
          name: input.name,
          email: input.email,
          role: input.role,
          passwordHash,
          branchId: actor.branchId,
          createdBy: actor.id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: users.id });
      if (!created) throw new Error("No se pudo crear el usuario");
      await auditUser(tx, actor, created.id, "user.created", input.role, null, now);
      return { ok: true, userId: created.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "email_taken" };
    throw error;
  }
}

async function preservesOwner(db: AppDb, user: User, changes: UserChanges) {
  if ((changes.role ?? user.role) === "owner" && (changes.isActive ?? user.isActive)) return true;
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.branchId, user.branchId),
        eq(users.role, "owner"),
        eq(users.isActive, true),
        ne(users.id, user.id),
      ),
    )
    .limit(1);
  return Boolean(owner);
}

async function updateUser(
  db: AppDb,
  actor: SessionUser,
  userId: string,
  changes: UserChanges,
  action: AuditAction,
  revoke: boolean,
  now: Date,
): Promise<UserResult> {
  return db.transaction(async (tx) => {
    await lockBranch(tx, actor.branchId);
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.branchId, actor.branchId)))
      .for("update");
    if (!user) return { ok: false, code: "not_found" };
    if (!(await preservesOwner(tx, user, changes))) return { ok: false, code: "last_owner" };
    await tx
      .update(users)
      .set({ ...changes, updatedAt: now })
      .where(and(eq(users.id, userId), eq(users.branchId, actor.branchId)));
    if (revoke) await revokeUserSessions(tx, userId, now);
    await auditUser(tx, actor, userId, action, changes.role ?? user.role, user.role, now);
    return { ok: true, userId };
  });
}

export async function setUserActive(
  db: AppDb,
  actor: SessionUser,
  userId: string,
  isActive: boolean,
  now: Date,
): Promise<UserResult> {
  if (!can(actor.role, "users.manage")) return { ok: false, code: "forbidden" };
  if (userId === actor.id) return { ok: false, code: "self_change" };
  return updateUser(
    db,
    actor,
    userId,
    { isActive },
    isActive ? "user.activated" : "user.deactivated",
    !isActive,
    now,
  );
}

export async function changeUserRole(
  db: AppDb,
  actor: SessionUser,
  userId: string,
  role: Role,
  now: Date,
): Promise<UserResult> {
  if (!can(actor.role, "users.manage")) return { ok: false, code: "forbidden" };
  if (userId === actor.id) return { ok: false, code: "self_change" };
  return updateUser(db, actor, userId, { role }, "user.role_changed", false, now);
}

export async function resetUserPassword(
  db: AppDb,
  actor: SessionUser,
  userId: string,
  password: string,
  now: Date,
): Promise<UserResult> {
  if (!can(actor.role, "users.manage")) return { ok: false, code: "forbidden" };
  if (userId === actor.id) return { ok: false, code: "self_change" };
  const passwordHash = await hashPassword(password);
  return updateUser(db, actor, userId, { passwordHash }, "user.password_reset", true, now);
}
