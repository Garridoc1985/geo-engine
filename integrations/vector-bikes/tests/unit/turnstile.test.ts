import { describe, expect, it, vi } from "vitest";
import { BookingTicket } from "../../src/components/islands/BookingTicket.tsx";
import { bookingReducer, initialState } from "../../src/components/islands/booking-state.ts";
import {
  type TurnstileApi,
  needsRender,
  safeGetResponse,
  safeRemove,
  safeRender,
  safeReset,
} from "../../src/components/islands/turnstile.ts";

class TurnstileError extends Error {
  override name = "TurnstileError";
}

/** Imita a Turnstile sin widgets dibujados: todo lo que recibe un id lanza. */
function brokenApi(): TurnstileApi {
  const fail = () => {
    throw new TurnstileError(
      "[Cloudflare Turnstile] Nothing to reset found for provided container.",
    );
  };
  return { render: fail, reset: fail, getResponse: fail, remove: fail };
}

const OPTIONS = {
  sitekey: "1x00000000000000000000AA",
  language: "es",
  callback: () => {},
  "expired-callback": () => {},
  "error-callback": () => {},
};

describe("llamadas seguras a Turnstile", () => {
  it("reset con un widgetId inexistente no lanza", () => {
    expect(() => safeReset(brokenApi(), "no-existe")).not.toThrow();
    expect(safeReset(brokenApi(), "no-existe")).toBe(false);
  });

  it("reset sin script o sin widget no hace nada", () => {
    expect(safeReset(undefined, "w1")).toBe(false);
    const api = { ...brokenApi(), reset: vi.fn() };
    expect(safeReset(api, null)).toBe(false);
    expect(api.reset).not.toHaveBeenCalled();
  });

  it("reset con widget vivo usa su id", () => {
    const api = { ...brokenApi(), reset: vi.fn() };
    expect(safeReset(api, "w1")).toBe(true);
    expect(api.reset).toHaveBeenCalledWith("w1");
  });

  it("render, getResponse y remove tampoco lanzan", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = {} as HTMLElement;
    expect(safeRender(brokenApi(), element, OPTIONS)).toBeNull();
    expect(safeRender(undefined, element, OPTIONS)).toBeNull();
    expect(safeGetResponse(brokenApi(), "w1")).toBeNull();
    expect(() => safeRemove(brokenApi(), "w1")).not.toThrow();
    error.mockRestore();
  });

  it("getResponse vacío cuenta como sin token", () => {
    const api = { ...brokenApi(), getResponse: () => "" };
    expect(safeGetResponse(api, "w1")).toBeNull();
    expect(safeGetResponse({ ...api, getResponse: () => "tok" }, "w1")).toBe("tok");
  });

  it("vuelve a dibujar si no hay widget o el contenedor quedó vacío", () => {
    expect(needsRender(null, { childElementCount: 1 })).toBe(true);
    expect(needsRender("w1", { childElementCount: 0 })).toBe(true);
    expect(needsRender("w1", { childElementCount: 1 })).toBe(false);
  });
});

describe("envío sin token de Turnstile", () => {
  const MESSAGE =
    "No pudimos cargar la verificación anti-spam. Recarga la página e intenta de nuevo.";

  it("no rompe: deja el mensaje de verificación en vez del error de red", () => {
    const next = bookingReducer(initialState, { type: "turnstileUnavailable" });
    expect(next.submit).toEqual({ status: "failed", message: MESSAGE });
    expect(next.turnstileToken).toBeNull();
  });

  it("el mensaje aparece en la boleta con role=alert", () => {
    const state = bookingReducer(initialState, { type: "turnstileUnavailable" });
    const ticket = JSON.stringify(
      BookingTicket({ state, chosen: [], isPickup: false }),
      (key, value) => (key === "__o" || key === "_owner" ? undefined : value),
    );
    expect(ticket).toContain('"role":"alert"');
    expect(ticket).toContain(MESSAGE);
  });
});
