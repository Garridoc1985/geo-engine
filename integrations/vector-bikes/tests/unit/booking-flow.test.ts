import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import { BookingTicket } from "../../src/components/islands/BookingTicket.tsx";
import {
  type State,
  bookingReducer,
  initialState,
  parseResponseBody,
  selectedBlocks,
  timeRange,
} from "../../src/components/islands/booking-state.ts";

/** Texto visible de un árbol de VNodes, resolviendo componentes función. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  const vnode = node as VNode<{ children?: unknown }>;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return textOf(vnode.props?.children);
}

function ticketText(state: State): string {
  const chosen = selectedBlocks(state);
  return textOf(BookingTicket({ state, chosen, isPickup: state.mode === "retiro" }));
}

/** Mismo camino que `submit` en BookingIsland: texto → cuerpo → reductor → boleta. */
function afterResponse(status: number, text: string): string {
  const state = bookingReducer(initialState, {
    type: "submitFailed",
    status,
    body: parseResponseBody(text),
  });
  return ticketText(state);
}

describe("error del envío visible en la boleta", () => {
  it("un 429 JSON muestra el mensaje del servidor", () => {
    const text = JSON.stringify({
      error: "Demasiados intentos desde tu conexión. Vuelve a intentar en 10 minutos.",
      code: "rate_limited",
    });
    expect(afterResponse(429, text)).toContain(
      "Demasiados intentos desde tu conexión. Vuelve a intentar en 10 minutos.",
    );
  });

  it("un 429 que no es JSON (HTML de un proxy) muestra el aviso de límite, no el de red", () => {
    const shown = afterResponse(429, "<html><body>Too Many Requests</body></html>");
    expect(shown).toContain("Demasiados intentos. Espera unos minutos e intenta de nuevo.");
    expect(shown).not.toContain("No pudimos confirmar tu reserva");
  });

  it("403 y 409 no JSON usan su respaldo; un 500 no JSON, el de red", () => {
    expect(afterResponse(403, "")).toContain("No pudimos verificar que eres una persona.");
    expect(afterResponse(409, "Conflict")).toContain("El bloque ya no está disponible");
    expect(afterResponse(500, "<html></html>")).toContain("No pudimos confirmar tu reserva");
  });

  it("parseResponseBody tolera HTML, vacío y JSON que no es objeto", () => {
    expect(parseResponseBody("<html></html>")).toEqual({});
    expect(parseResponseBody("")).toEqual({});
    expect(parseResponseBody("null")).toEqual({});
    expect(parseResponseBody('{"code":"rate_limited"}')).toEqual({ code: "rate_limited" });
  });
});

describe("validación local en la boleta", () => {
  it("el mensaje general aparece sobre el botón, con role=alert", () => {
    const state = bookingReducer(initialState, {
      type: "submitFailed",
      status: 422,
      body: { fields: { bloque: "Elige un bloque libre para continuar." } },
    });
    const ticket = BookingTicket({ state, chosen: [], isPickup: false }) as VNode<{
      children: unknown[];
    }>;
    const foot = (ticket.props.children as VNode<{ class?: string; children: VNode[] }>[])
      .flat()
      .find((child) => child?.props?.class === "ticket-foot");
    const [first, second] = (foot?.props.children ?? []).filter(Boolean) as VNode<{
      role?: string;
      id?: string;
    }>[];
    expect(first?.props.role).toBe("alert");
    expect(textOf(first)).toBe("Elige un bloque libre para continuar.");
    expect(second?.props.id).toBe("submit");
  });
});

describe("hora de la boleta", () => {
  const at = (mode: State["mode"], start: string): State => ({
    ...initialState,
    mode,
    selectedDate: "2026-09-16",
    selectedStart: start,
  });

  it("retiro a las 17:00 va de 17:00 a 18:00", () => {
    expect(timeRange(selectedBlocks(at("retiro", "17:00")))).toBe("17:00 – 18:00");
    expect(ticketText(at("retiro", "17:00"))).toContain("17:00 – 18:00");
  });

  it("taller a las 17:00 va de 17:00 a 17:30 y cruza la hora bien", () => {
    expect(timeRange(selectedBlocks(at("taller", "17:00")))).toBe("17:00 – 17:30");
    expect(timeRange(selectedBlocks(at("retiro", "18:30")))).toBe("18:30 – 19:30");
  });

  it("sin bloque pide elegir uno", () => {
    expect(timeRange([])).toBeNull();
    expect(ticketText(initialState)).toContain("Elige un bloque");
  });
});
