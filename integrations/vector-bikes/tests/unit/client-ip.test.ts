import { describe, expect, it } from "vitest";
import { clientIp, ipFromForwardedFor } from "../../src/server/api/client-ip.ts";

function request(headers: Record<string, string>): Request {
  return new Request("https://vectorbikes.cl/api/reservas", { headers });
}

describe("ipFromForwardedFor", () => {
  it("toma la IP real en una petición normal de Replit", () => {
    expect(ipFromForwardedFor("186.11.20.30, 34.117.1.2, 35.191.3.4, 34.95.5.6")).toBe(
      "186.11.20.30",
    );
  });

  it("ignora una IP falsa antepuesta por el cliente", () => {
    expect(ipFromForwardedFor("1.2.3.4, 186.11.20.30, 34.117.1.2, 35.191.3.4, 34.151.7.8")).toBe(
      "186.11.20.30",
    );
  });

  it("salta redes privadas, loopback e IPv6 de confianza", () => {
    expect(ipFromForwardedFor("190.5.1.2, 10.0.0.1, 172.16.4.4, 192.168.1.1, 127.0.0.1")).toBe(
      "190.5.1.2",
    );
    expect(ipFromForwardedFor("2800:150:1::7, ::1, fd00::1, fe80::1")).toBe("2800:150:1::7");
  });

  it("172.32.x.x no es privada", () => {
    expect(ipFromForwardedFor("190.5.1.2, 172.32.0.1, 10.0.0.1")).toBe("172.32.0.1");
  });

  it("si todas son de confianza, usa la última", () => {
    expect(ipFromForwardedFor("10.0.0.1, 34.117.1.2, 35.191.3.4")).toBe("35.191.3.4");
  });

  it("salta valores que no son IP", () => {
    expect(ipFromForwardedFor("unknown, 186.11.20.30, basura, 34.117.1.2")).toBe("186.11.20.30");
    expect(ipFromForwardedFor(" , basura")).toBeNull();
  });
});

describe("clientIp", () => {
  it("usa x-forwarded-for antes que los respaldos", () => {
    const headers = {
      "x-forwarded-for": "1.2.3.4, 186.11.20.30, 34.117.1.2",
      "x-real-ip": "190.5.1.3",
    };
    expect(clientIp(request(headers), "10.0.0.9")).toBe("186.11.20.30");
  });

  it("sin x-forwarded-for sigue con x-real-ip y luego cf-connecting-ip", () => {
    expect(
      clientIp(request({ "x-real-ip": "190.5.1.3", "cf-connecting-ip": "190.5.1.4" }), null),
    ).toBe("190.5.1.3");
    expect(clientIp(request({ "cf-connecting-ip": "190.5.1.4" }), null)).toBe("190.5.1.4");
  });

  it("ignora cabeceras vacías y usa la IP del servidor al final", () => {
    expect(clientIp(request({ "x-forwarded-for": " ", "x-real-ip": "" }), "10.0.0.9")).toBe(
      "10.0.0.9",
    );
    expect(clientIp(request({}), null)).toBeNull();
  });
});
