import { errorMessage, log } from "../../lib/log.ts";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Verifica el token de Turnstile. Cualquier fallo de red o de formato es un `false`. */
export async function verifyTurnstile(args: {
  token: string;
  ip: string | null;
  secret: string;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const body = new URLSearchParams({ secret: args.secret, response: args.token });
  if (args.ip) {
    body.set("remoteip", args.ip);
  }
  try {
    const doFetch = args.fetchFn ?? fetch;
    const response = await doFetch(VERIFY_URL, { method: "POST", body });
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch (error) {
    log.error("turnstile.error", { message: errorMessage(error) });
    return false;
  }
}
