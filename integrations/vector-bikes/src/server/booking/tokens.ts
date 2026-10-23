import { createHmac, randomBytes } from "node:crypto";
import { getCancelEnv } from "../../lib/env.ts";

/** Token de cancelación de un solo uso. Solo viaja en el correo del cliente. */
export function newCancelToken(): string {
  return randomBytes(32).toString("base64url");
}

/** HMAC-SHA-256 en hex: la base guarda el hash, nunca el token. */
export function hashCancelToken(
  token: string,
  secret: string = getCancelEnv().CANCEL_TOKEN_SECRET,
): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}
