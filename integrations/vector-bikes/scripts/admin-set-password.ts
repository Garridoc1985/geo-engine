import { getAdminSetupEnv } from "../src/lib/env.ts";
import { setAdminPassword } from "../src/server/auth/admin-auth.ts";
import { getDb } from "../src/server/db/client.ts";

// Las variables se validan antes de abrir cualquier conexión a la base.
let adminEnv: ReturnType<typeof getAdminSetupEnv>;
try {
  adminEnv = getAdminSetupEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

try {
  const email = adminEnv.ADMIN_EMAIL.trim().toLowerCase();
  const action = await setAdminPassword(getDb(), email, adminEnv.ADMIN_PASSWORD, new Date());
  console.log(JSON.stringify({ ok: true, email, action, role: "owner" }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
