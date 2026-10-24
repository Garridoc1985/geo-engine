import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
