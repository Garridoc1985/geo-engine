import { getDb } from "../src/server/db/client.ts";
import { sendReminders } from "../src/server/email/reminders.ts";

// El `process.exit` explícito cierra el pool de postgres; sin él el proceso no termina.
try {
  const result = await sendReminders(getDb(), new Date());
  const ok = result.failed === 0;
  console.log(JSON.stringify({ ok, sent: result.sent, failed: result.failed }));
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
