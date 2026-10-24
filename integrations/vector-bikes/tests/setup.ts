// Valores de prueba. Los tests nunca usan la red ni secretos reales.
const forced: Record<string, string> = {
  EMAIL_TRANSPORT: "console",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  SESSION_SECRET: "test-session-secret-0123456789abcdef0123",
  CANCEL_TOKEN_SECRET: "test-cancel-secret-0123456789abcdef01234",
  EMAIL_FROM: "Vector Bikes <reservas@send.vectorbikes.cl>",
  EMAIL_REPLY_TO: "info@vectorbikes.cl",
  SHOP_NOTIFY_EMAIL: "info@vectorbikes.cl",
};

for (const [key, value] of Object.entries(forced)) {
  process.env[key] = value;
}

// Misma regla que astro.config.mjs, para que los tests del build esperen el mismo `site`.
if (!process.env.PUBLIC_SITE_URL) {
  process.env.PUBLIC_SITE_URL = "https://vectorbikes.cl";
}

export {};
