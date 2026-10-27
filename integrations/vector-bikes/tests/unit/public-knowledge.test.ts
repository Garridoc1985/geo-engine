import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Services from "../../src/public-test/pages/servicios.astro";
import { KNOWLEDGE_VERSION, PUBLIC_KNOWLEDGE } from "../../src/lib/public-knowledge.ts";

describe("publicación compartida de Vector Bikes", () => {
  it("muestra en servicios la misma versión y los registros que consume el asistente", async () => {
    const container = await AstroContainer.create({
      astroConfig: { site: "https://vectorbikestest.cl" },
    });
    const html = await container.renderToString(Services, {
      request: new Request("https://vectorbikestest.cl/servicios/"),
    });
    expect(html).toContain(`data-knowledge-version="${KNOWLEDGE_VERSION}"`);
    for (const item of PUBLIC_KNOWLEDGE.items) {
      expect(html).toContain(item.title);
      for (const paragraph of item.content.split(/\n\s*\n/)) {
        expect(html).toContain(paragraph);
      }
    }
    expect(html).toContain('href="/geo/"');
    expect(html).not.toContain('href="/#reservar"');
  });
});
