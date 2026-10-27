import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import { assistantResponse } from "../../src/server/assistant.ts";
import { KNOWLEDGE_VERSION, PUBLIC_KNOWLEDGE } from "../../src/lib/public-knowledge.ts";

const origin = "https://vectorbikestest.cl";
function request(body: unknown = { question: "¿Cuál es el horario?" }, requestOrigin = origin) {
  return new Request(`${origin}/api/asistente`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function* events(type = "response.completed") {
  yield { type: "response.output_text.delta", delta: "Recepción de lunes a viernes." };
  yield { type };
}
beforeEach(() => {
  vi.stubEnv("AI_ASSISTANT_ENABLED", "true");
  vi.stubEnv("AI_MODEL", "test-model");
  vi.stubEnv("OPENAI_API_KEY", "not-a-real-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid");
  create.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("asistente público", () => {
  it("rechaza orígenes ajenos antes de invocar el proveedor", async () => {
    expect((await assistantResponse(request(undefined, "https://otro.invalid"))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it("rechaza preguntas extensas y roles inyectados", async () => {
    for (const body of [{ question: "x".repeat(801) }, { question: "Hola", role: "system" }]) {
      expect((await assistantResponse(request(body))).status).toBe(422);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("permanece desactivado sin habilitación explícita", async () => {
    vi.stubEnv("AI_ASSISTANT_ENABLED", "false");
    expect((await assistantResponse(request())).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
  it("entrega fragmentos y confirma solo respuestas completadas", async () => {
    create.mockResolvedValue(events());
    const response = await assistantResponse(request());
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-knowledge-version")).toBe(KNOWLEDGE_VERSION);
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      store: false,
      stream: true,
      max_output_tokens: 600,
    });
    const instructions = create.mock.calls[0]?.[0].instructions;
    expect(instructions).toContain(JSON.stringify(PUBLIC_KNOWLEDGE));
    expect(instructions).toContain(KNOWLEDGE_VERSION);
  });
  it("informa fallos del proveedor sin filtrar detalles", async () => {
    create.mockRejectedValue(new Error("secret-provider-diagnostic"));
    const response = await assistantResponse(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-provider-diagnostic");
  });
  it("no presenta un stream incompleto como finalizado", async () => {
    create.mockResolvedValue(events("response.incomplete"));
    const text = await (await assistantResponse(request())).text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: done");
  });
  it("rechaza cuerpos grandes aunque no indiquen Content-Length", async () => {
    const response = await assistantResponse(request({ question: "x".repeat(5000) }));
    expect(response.status).toBe(422);
    expect(create).not.toHaveBeenCalled();
  });
  it("no invoca el proveedor si faltan credenciales o modelo", async () => {
    for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AI_MODEL"]) {
      vi.stubEnv(name, "");
      expect((await assistantResponse(request())).status).toBe(503);
      vi.stubEnv(
        name,
        name === "AI_MODEL"
          ? "test-model"
          : name === "OPENAI_BASE_URL"
            ? "https://example.invalid"
            : "not-a-real-key",
      );
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("cancela el proveedor cuando el visitante deja de leer", async () => {
    let providerSignal: AbortSignal | undefined;
    create.mockImplementation((_input, options) => {
      providerSignal = options.signal;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "Respuesta parcial" };
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    });
    const response = await assistantResponse(request());
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(providerSignal?.aborted).toBe(true);
  });
  it("interrumpe respuestas que exceden 45 segundos", async () => {
    vi.useFakeTimers();
    create.mockImplementation((_input, options) =>
      (async function* () {
        yield { type: "response.output_text.delta", delta: "Respuesta parcial" };
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      })(),
    );
    const response = await assistantResponse(request());
    const rejection = expect(response.text()).rejects.toThrow("La respuesta se interrumpió.");
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;
  });
});
