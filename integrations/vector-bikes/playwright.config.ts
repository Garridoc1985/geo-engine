import { defineConfig } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_DATABASE_URL,
  E2E_PORT,
  E2E_STORAGE_DIR,
  E2E_TASKS_SECRET,
} from "./e2e/fixtures.ts";

// Solo flujos de /taller, en un viewport de tablet táctil. Ver .claude/rules/e2e.md.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: E2E_BASE_URL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "tablet",
      use: {
        browserName: "chromium",
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: "es-CL",
        timezoneId: "America/Santiago",
      },
    },
  ],
  webServer: {
    command: "node dist/server/entry.mjs",
    url: `${E2E_BASE_URL}/robots.txt`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      HOST: "127.0.0.1",
      PORT: String(E2E_PORT),
      DATABASE_URL: E2E_DATABASE_URL,
      PUBLIC_SITE_URL: E2E_BASE_URL,
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef012",
      CANCEL_TOKEN_SECRET: "e2e-cancel-secret-0123456789abcdef0123",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      EMAIL_TRANSPORT: "console",
      EMAIL_FROM: "Vector Bikes <reservas@send.vectorbikes.cl>",
      EMAIL_REPLY_TO: "info@vectorbikes.cl",
      SHOP_NOTIFY_EMAIL: "info@vectorbikes.cl",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: E2E_STORAGE_DIR,
      TASKS_SECRET: E2E_TASKS_SECRET,
      WHATSAPP_ENABLED: "false",
    },
  },
});
