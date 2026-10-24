import { z } from "zod";

type EnvSource = Record<string, string | undefined>;

/** El asistente permanece apagado hasta configurar proveedor y aprobar su salida. */
export function getAssistantEnv(source: EnvSource = process.env) {
  return {
    enabled: source.AI_ASSISTANT_ENABLED === "true",
    model: source.AI_MODEL?.trim(),
    configured: Boolean(source.OPENAI_API_KEY && source.OPENAI_BASE_URL),
  };
}

export class EnvError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Variable de entorno faltante o inválida: ${variables.join(", ")}`);
    this.name = "EnvError";
    this.variables = variables;
  }
}

function parseSource<T extends z.ZodType>(schema: T, source: EnvSource): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = result.error.issues.map((issue) => String(issue.path[0] ?? "desconocida"));
    throw new EnvError([...new Set(names)]);
  }
  return result.data;
}

const required = z.string().trim().min(1);
const secret = z.string().min(32);

const dbSchema = z.object({ DATABASE_URL: required });
const cancelSchema = z.object({ CANCEL_TOKEN_SECRET: secret });
const turnstileSchema = z.object({ TURNSTILE_SECRET_KEY: required });
const hashSchema = z.object({ SESSION_SECRET: secret });
const tasksSchema = z.object({ TASKS_SECRET: secret });
const cronSchema = z.object({ CRON_SECRET: z.string().optional() });
const siteSchema = z.object({ PUBLIC_SITE_URL: z.url() });
const absentIfEmpty = (value: unknown) => (value === "" ? undefined : value);
const storageSchema = z
  .object({
    STORAGE_DRIVER: z.preprocess(absentIfEmpty, z.enum(["local", "replit"]).default("local")),
    STORAGE_LOCAL_DIR: z.preprocess(absentIfEmpty, z.string().default(".storage")),
    STORAGE_BUCKET_ID: z.preprocess(absentIfEmpty, z.string().optional()),
    REPLIT_DEPLOYMENT: z.preprocess(absentIfEmpty, z.string().optional()),
  })
  .superRefine((value, ctx) => {
    if (value.REPLIT_DEPLOYMENT !== undefined && value.STORAGE_DRIVER !== "replit") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_DRIVER"],
        message: "debe ser replit en un despliegue de Replit",
      });
    }
  });
type StorageEnv = Omit<z.infer<typeof storageSchema>, "REPLIT_DEPLOYMENT">;
const emailSchema = z
  .object({
    EMAIL_TRANSPORT: z.enum(["resend", "console"]),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: required,
    EMAIL_REPLY_TO: z.email(),
    SHOP_NOTIFY_EMAIL: z.email(),
  })
  .superRefine((value, ctx) => {
    if (value.EMAIL_TRANSPORT === "resend" && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "requerida cuando EMAIL_TRANSPORT=resend",
      });
    }
  });
const adminSetupSchema = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12),
});

const whatsappSchema = z
  .object({
    WHATSAPP_ENABLED: z.enum(["true", "false"]).default("false"),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
    WHATSAPP_GRAPH_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default("v23.0"),
    WHATSAPP_REMINDER_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_READY_TEMPLATE: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    WHATSAPP_TEMPLATE_LANGUAGE: z
      .string()
      .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
      .default("es_CL"),
  })
  .superRefine((value, ctx) => {
    if (value.WHATSAPP_ENABLED !== "true") return;
    for (const key of [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_REMINDER_TEMPLATE",
      "WHATSAPP_READY_TEMPLATE",
    ] as const) {
      if (!value[key])
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "requerida cuando WhatsApp está habilitado",
        });
    }
  });

export type EmailEnv = z.infer<typeof emailSchema>;

/** Paso 2 en adelante. */
export function getDbEnv(source: EnvSource = process.env) {
  return parseSource(dbSchema, source);
}

/** Paso 4 en adelante. */
export function getCancelEnv(source: EnvSource = process.env) {
  return parseSource(cancelSchema, source);
}

/** Paso 5 en adelante. */
export function getTurnstileEnv(source: EnvSource = process.env) {
  return parseSource(turnstileSchema, source);
}

/** Paso 5 en adelante. */
export function getHashEnv(source: EnvSource = process.env) {
  return parseSource(hashSchema, source);
}

/** Paso 8 en adelante. */
export function getSiteEnv(source: EnvSource = process.env) {
  return parseSource(siteSchema, source);
}

/** Paso 8 en adelante. */
export function getEmailEnv(source: EnvSource = process.env): EmailEnv {
  return parseSource(emailSchema, source);
}

/** Solo scripts/admin-set-password.ts (paso 10). */
export function getAdminSetupEnv(source: EnvSource = process.env) {
  return parseSource(adminSetupSchema, source);
}

export function getWhatsAppEnv(source: EnvSource = process.env) {
  if (source.WHATSAPP_ENABLED !== "true") {
    return parseSource(whatsappSchema, { WHATSAPP_ENABLED: source.WHATSAPP_ENABLED });
  }
  return parseSource(whatsappSchema, source);
}

export function getTasksEnv(source: EnvSource = process.env) {
  return parseSource(tasksSchema, source);
}

export function getCronEnv(source: EnvSource = process.env) {
  return parseSource(cronSchema, source);
}

export function getStorageEnv(source: EnvSource = process.env): StorageEnv {
  const parsed = parseSource(storageSchema, source);
  return {
    STORAGE_DRIVER: parsed.STORAGE_DRIVER,
    STORAGE_LOCAL_DIR: parsed.STORAGE_LOCAL_DIR,
    STORAGE_BUCKET_ID: parsed.STORAGE_BUCKET_ID,
  };
}
