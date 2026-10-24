type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const REDACTED_KEYS = new Set([
  "email",
  "correo",
  "phone",
  "phone_e164",
  "phoneE164",
  "telefono",
  "customer_name",
  "customerName",
  "nombre",
  "address",
  "direccion",
  "token",
  "cancelToken",
  "password",
]);

function redact(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.has(key) ? "[redactado]" : redact(inner, depth + 1);
  }
  return output;
}

function write(level: LogLevel, event: string, fields: LogFields): void {
  const safe = redact(fields, 0) as LogFields;
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...safe });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
