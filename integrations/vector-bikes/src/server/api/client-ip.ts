import { BlockList, isIP } from "node:net";

/**
 * Saltos de confianza entre el cliente y la app: infraestructura de Google/Replit
 * (34/8 y 35/8, medido en producción el 2026-09-16), redes privadas y loopback.
 */
const TRUSTED = new BlockList();
TRUSTED.addSubnet("34.0.0.0", 8, "ipv4");
TRUSTED.addSubnet("35.0.0.0", 8, "ipv4");
TRUSTED.addSubnet("10.0.0.0", 8, "ipv4");
TRUSTED.addSubnet("172.16.0.0", 12, "ipv4");
TRUSTED.addSubnet("192.168.0.0", 16, "ipv4");
TRUSTED.addSubnet("127.0.0.0", 8, "ipv4");
TRUSTED.addAddress("::1", "ipv6");
TRUSTED.addSubnet("fc00::", 7, "ipv6");
TRUSTED.addSubnet("fe80::", 10, "ipv6");

function isTrusted(ip: string): boolean {
  const version = isIP(ip);
  return version !== 0 && TRUSTED.check(ip, version === 4 ? "ipv4" : "ipv6");
}

/**
 * "Rightmost non-trusted": el cliente puede anteponer valores falsos a `x-forwarded-for`,
 * pero no puede tocar lo que agregan los proxies a la derecha. Se recorre de derecha a
 * izquierda y se devuelve la primera dirección válida que no sea de confianza; si todas lo
 * son, la última. Valores que no son IP se saltan.
 */
export function ipFromForwardedFor(header: string): string | null {
  const addresses = header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => isIP(entry) !== 0);
  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const ip = addresses[index];
    if (ip !== undefined && !isTrusted(ip)) {
      return ip;
    }
  }
  return addresses.at(-1) ?? null;
}

/** IP del cliente: `x-forwarded-for`; sin él, `x-real-ip`, `cf-connecting-ip` y la del servidor. */
export function clientIp(request: Request, fallback: string | null): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const fromForwarded = forwarded ? ipFromForwardedFor(forwarded) : null;
  if (fromForwarded) {
    return fromForwarded;
  }
  for (const name of ["x-real-ip", "cf-connecting-ip"]) {
    const ip = request.headers.get(name)?.trim();
    if (ip) {
      return ip;
    }
  }
  return fallback;
}
