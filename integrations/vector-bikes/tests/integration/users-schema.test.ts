import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestDb } from "../helpers/pglite.ts";
import type { TestDb } from "../helpers/pglite.ts";

function sqlState(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && typeof error.code === "string") return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

async function expectSqlState(query: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(sqlState(caught)).toBe(code);
}

async function insertBranch(test: TestDb) {
  const result = await test.client.query<{ id: string }>(
    "insert into branches (name) values ('Vitacura') returning id",
  );
  return result.rows[0]?.id;
}

async function insertUser(test: TestDb, branchId: string | undefined, role = "owner") {
  const result = await test.client.query<{ id: string; is_active: boolean; created_by: null }>(
    `insert into users (branch_id, email, password_hash, name, role)
     values ($1, $2, 'test-hash', 'Usuario de prueba', $3)
     returning id, is_active, created_by`,
    [branchId, `${role}@ejemplo.cl`, role],
  );
  return result.rows[0];
}

async function insertBooking(test: TestDb, source?: string) {
  const columns = source === undefined ? "" : ", source";
  const values = source === undefined ? "" : ", $2";
  return test.client.query<{ source: string }>(
    `insert into bookings (
       code, service_date, mode, starts_at, ends_at, customer_name, phone_e164,
       email, bike, description, consent_at, cancel_token_hash${columns}
     ) values (
       $1, '2026-10-05', 'taller', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z',
       'Cliente de prueba', '+56912345678', 'cliente@ejemplo.cl', 'Ruta',
       'Mantención', '2026-10-01T12:00:00Z', $1${values}
     ) returning source`,
    source === undefined ? ["booking-default"] : [`booking-${source}`, source],
  );
}

let test: TestDb;
beforeEach(async () => {
  test = await createTestDb();
});
afterEach(async () => {
  await test.close();
});

it("aplica las migraciones con la autenticación legada contraída", async () => {
  const result = await test.client.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(
    `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name in
       ('branches', 'users', 'admin_users', 'admin_sessions', 'bookings')`,
  );
  const columns = result.rows;
  expect(columns.filter((row) => row.table_name === "admin_users")).toEqual([]);
  const legacyTables = await test.client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = 'admin_users'`,
  );
  expect(legacyTables.rows).toEqual([]);
  for (const tableName of ["branches", "users"]) {
    for (const columnName of ["id", "created_at", "updated_at"]) {
      expect(columns).toContainEqual({
        table_name: tableName,
        column_name: columnName,
        is_nullable: "NO",
      });
    }
  }
  expect(columns).toContainEqual({
    table_name: "admin_sessions",
    column_name: "user_id",
    is_nullable: "NO",
  });
  expect(
    columns.filter(
      (row) => row.table_name === "admin_sessions" && row.column_name === "admin_user_id",
    ),
  ).toEqual([]);
  expect(columns).toContainEqual({
    table_name: "bookings",
    column_name: "source",
    is_nullable: "NO",
  });
});

it("no siembra sucursales ni usuarios al migrar", async () => {
  const counts = await test.client.query<{ branches: number; users: number }>(
    "select (select count(*)::int from branches) as branches, (select count(*)::int from users) as users",
  );
  expect(counts.rows).toEqual([{ branches: 0, users: 0 }]);
});

it("rechaza una sesión sin user_id con SQLSTATE 23502", async () => {
  await expectSqlState(
    test.client.query(
      `insert into admin_sessions (token_hash, expires_at)
       values ('session-without-user', '2026-10-06T12:00:00Z')`,
    ),
    "23502",
  );
});

it("rechaza un rol inválido con SQLSTATE 23514", async () => {
  const branchId = await insertBranch(test);
  await expectSqlState(insertUser(test, branchId, "customer"), "23514");
});

it.each(["owner", "admin", "reception", "mechanic"])(
  "acepta el rol %s y sus valores por defecto",
  async (role) => {
    const user = await insertUser(test, await insertBranch(test), role);
    expect(user).toMatchObject({ is_active: true, created_by: null });
    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
  },
);

it("guarda web al omitir source", async () => {
  expect((await insertBooking(test)).rows).toEqual([{ source: "web" }]);
});

it.each(["web", "telefono", "whatsapp", "presencial"])("acepta el origen %s", async (source) => {
  expect((await insertBooking(test, source)).rows).toEqual([{ source }]);
});

it("rechaza un origen inválido con SQLSTATE 23514", async () => {
  await expectSqlState(insertBooking(test, "email"), "23514");
});

it("acepta una sesión por user_id y la elimina al borrar su usuario", async () => {
  const user = await insertUser(test, await insertBranch(test));
  const session = await test.client.query<{ user_id: string }>(
    `insert into admin_sessions (user_id, token_hash, expires_at)
       values ($1, 'new-session-hash', '2026-10-06T12:00:00Z') returning user_id`,
    [user?.id],
  );
  expect(session.rows).toEqual([{ user_id: user?.id }]);
  await test.client.query("delete from users where id = $1", [user?.id]);
  expect((await test.client.query("select id from admin_sessions")).rows).toEqual([]);
});

it("exige sucursal y restringe su borrado mientras tenga usuarios", async () => {
  const branchId = await insertBranch(test);
  await insertUser(test, branchId);
  await expectSqlState(insertUser(test, undefined, "admin"), "23502");
  await expectSqlState(insertUser(test, "00000000-0000-0000-0000-000000000001", "admin"), "23503");
  await expectSqlState(
    test.client.query("delete from branches where id = $1", [branchId]),
    "23001",
  );
});

it("exige nombres de sucursal únicos y numeración positiva", async () => {
  await insertBranch(test);
  await expectSqlState(insertBranch(test), "23505");
  await expectSqlState(
    test.client.query("insert into branches (name, next_order_number) values ('Otra', 0)"),
    "23514",
  );
  const result = await test.client.query<{ next_order_number: number }>(
    "select next_order_number from branches",
  );
  expect(result.rows).toEqual([{ next_order_number: 1 }]);
});

it("exige correos únicos y restringe el borrado del creador de un usuario", async () => {
  const branchId = await insertBranch(test);
  const creator = await insertUser(test, branchId);
  await expectSqlState(insertUser(test, branchId), "23505");
  await test.client.query(
    `insert into users (branch_id, email, password_hash, name, role, created_by)
       values ($1, 'admin@ejemplo.cl', 'test-hash', 'Administrador', 'admin', $2)`,
    [branchId, creator?.id],
  );
  await expectSqlState(
    test.client.query("delete from users where id = $1", [creator?.id]),
    "23001",
  );
});

it("crea los índices nuevos con los nombres especificados", async () => {
  const result = await test.client.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'public'",
  );
  const names = result.rows.map((row) => row.indexname);
  for (const name of [
    "uq_branches_name",
    "uq_users_email",
    "idx_users_branch_role",
    "idx_admin_sessions_user_id",
  ]) {
    expect(names).toContain(name);
  }
});
