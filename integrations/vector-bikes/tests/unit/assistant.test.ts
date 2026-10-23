import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import { assistantResponse } from "../../src/server/assistant.ts";

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
afterEach(() => vi.unstubAllEnvs());
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
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      store: false,
      stream: true,
      max_output_tokens: 600,
    });
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
});
