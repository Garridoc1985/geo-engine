import { useEffect, useRef, useState } from "preact/hooks";

export type TurnstileOptions = {
  sitekey: string;
  language: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

export type TurnstileApi = {
  render: (element: HTMLElement, options: TurnstileOptions) => string | undefined;
  reset: (widgetId?: string) => void;
  getResponse: (widgetId?: string) => string | undefined;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onloadTurnstileCallback?: () => void;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback";
const LOAD_TIMEOUT_MS = 10_000;
const MAX_RENDER_ATTEMPTS = 3;

/** Ninguna llamada a Turnstile puede romper el envío: todas devuelven un valor neutro. */
export function safeRender(
  api: TurnstileApi | undefined,
  element: HTMLElement,
  options: TurnstileOptions,
): string | null {
  try {
    return api?.render(element, options) ?? null;
  } catch (error) {
    console.error("turnstile.render", error);
    return null;
  }
}

export function safeReset(api: TurnstileApi | undefined, widgetId: string | null): boolean {
  if (!api || widgetId === null) {
    return false;
  }
  try {
    api.reset(widgetId);
    return true;
  } catch {
    return false;
  }
}

export function safeGetResponse(
  api: TurnstileApi | undefined,
  widgetId: string | null,
): string | null {
  if (!api || widgetId === null) {
    return null;
  }
  try {
    return api.getResponse(widgetId) || null;
  } catch {
    return null;
  }
}

export function safeRemove(api: TurnstileApi | undefined, widgetId: string | null): void {
  if (!api || widgetId === null) {
    return;
  }
  try {
    api.remove(widgetId);
  } catch {
    // El widget ya no existe: no hay nada que quitar.
  }
}

/** Turnstile dibuja un iframe dentro del contenedor; vacío = hay que volver a dibujar. */
export function needsRender(
  widgetId: string | null,
  container: { childElementCount: number },
): boolean {
  return widgetId === null || container.childElementCount === 0;
}

/** Carga el script una sola vez; con `render=explicit` se dibuja en el callback `onload`. */
function loadScript(onReady: () => void): () => void {
  if (window.turnstile) {
    onReady();
    return () => {};
  }
  const previous = window.onloadTurnstileCallback;
  window.onloadTurnstileCallback = () => {
    previous?.();
    onReady();
  };
  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }
  const timer = window.setTimeout(() => {
    if (!window.turnstile) {
      console.error(`turnstile: el script no cargó en ${LOAD_TIMEOUT_MS / 1000} s`);
    }
  }, LOAD_TIMEOUT_MS);
  return () => window.clearTimeout(timer);
}

/**
 * Dibuja el widget cuando el script está listo y lo vuelve a dibujar si un re-render deja el
 * contenedor vacío. Devuelve el token vigente (callback o `getResponse`) y un `reset` seguro.
 */
export function useTurnstile(
  siteKey: string,
  containerRef: { current: HTMLElement | null },
  onToken: (token: string | null) => void,
) {
  const [loaded, setLoaded] = useState(false);
  const widgetId = useRef<string | null>(null);
  const attempts = useRef(0);

  useEffect(() => (siteKey === "" ? undefined : loadScript(() => setLoaded(true))), [siteKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!loaded || !container) {
      return;
    }
    if (!needsRender(widgetId.current, container)) {
      attempts.current = 0;
      return;
    }
    if (attempts.current >= MAX_RENDER_ATTEMPTS) {
      return;
    }
    attempts.current += 1;
    safeRemove(window.turnstile, widgetId.current);
    widgetId.current = safeRender(window.turnstile, container, {
      sitekey: siteKey,
      language: "es",
      callback: (token) => onToken(token),
      "expired-callback": () => onToken(null),
      "error-callback": () => onToken(null),
    });
  });

  return {
    enabled: siteKey !== "",
    token: () => safeGetResponse(window.turnstile, widgetId.current),
    reset: () => safeReset(window.turnstile, widgetId.current),
  };
}
