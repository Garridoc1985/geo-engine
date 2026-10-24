import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Misma regla que `astro.config.mjs`. */
const site = process.env.PUBLIC_SITE_URL || "https://vectorbikes.cl";
const home = new URL("/", site).href;

function read(path: string): string {
  return readFileSync(`dist/client/${path}`, "utf8");
}

const index = read("index.html");

function jsonLdBlocks(html: string): string[] {
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

type LocalBusiness = {
  "@type": string;
  address: { streetAddress: string; addressLocality: string; addressCountry: string };
  openingHoursSpecification: unknown[];
  sameAs: string[];
};

type FaqPage = { "@type": string; mainEntity: unknown[] };
type Graph = { "@graph": { "@type": string }[] };

/** Devuelve el nodo del `@graph` con ese `@type`. */
function node<T extends { "@type": string }>(block: string, type: string): T {
  const found = (JSON.parse(block) as Graph)["@graph"].find((entry) => entry["@type"] === type);
  if (!found) throw new Error(`Falta el nodo ${type} en el @graph.`);
  return found as T;
}

describe("SEO del build", () => {
  it("la landing tiene un único JSON-LD con LocalBusiness y FAQPage", () => {
    expect(index.split("application/ld+json").length - 1).toBe(1);
    const [block] = jsonLdBlocks(index);
    const data = node<LocalBusiness>(block ?? "{}", "LocalBusiness");

    expect(data["@type"]).toBe("LocalBusiness");
    expect(data.address.streetAddress).toBe("Avenida Kennedy 7666");
    expect(data.address.addressLocality).toBe("Vitacura");
    expect(data.address.addressCountry).toBe("CL");
    expect(data.openingHoursSpecification).toHaveLength(2);
    expect(data.sameAs).toContain("https://instagram.com/vector.bikes");
    expect(node<FaqPage>(block ?? "{}", "FAQPage").mainEntity).toHaveLength(5);
  });

  it("la landing declara canonical y Open Graph", () => {
    expect(index).toContain(`rel="canonical" href="${home}"`);
    expect(index).toContain('property="og:image"');
    expect(index).toContain(`content="${new URL("/brand/vector-bikes-logo.png", site).href}"`);
  });

  it("declara el favicon SVG con respaldo PNG y apple-touch-icon", () => {
    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg"');
    expect(index).toContain('<link rel="icon" type="image/png" href="/brand/favicon-32.png"');
    expect(index).toContain('<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"');
    expect(read("favicon.svg")).toContain('href="/brand/vector-bikes-logo.png"');
  });

  it("publica el aviso de privacidad sin JSON-LD", () => {
    const privacy = read("privacidad/index.html");

    expect(privacy).toContain("Aviso de privacidad");
    expect(privacy).toContain("Ley 21.719");
    expect(privacy).not.toContain("application/ld+json");
  });

  it("la 404 no se indexa", () => {
    const notFound = read("404.html");

    expect(notFound).toContain("Página no encontrada");
    expect(notFound).toContain('<meta name="robots" content="noindex"');
  });

  it("el sitemap lista la landing y la privacidad, y no las rutas privadas", () => {
    const sitemap = read("sitemap-0.xml");

    expect(sitemap).toContain(home);
    expect(sitemap).toContain("/privacidad");
    expect(sitemap).not.toContain("/admin");
    expect(sitemap).not.toContain("/reservas");
    expect(sitemap).not.toContain("/taller");
    // Lista blanca: solo la landing y la privacidad. Una página nueva no entra sola.
    expect(sitemap.split("<loc>").length - 1).toBe(2);
  });

  it("robots.txt bloquea el panel y la cancelación", () => {
    const robots = read("robots.txt");

    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain("Disallow: /reservas/cancelar");
  });

  it("robots.txt bloquea el área del taller", () => {
    expect(read("robots.txt")).toContain("Disallow: /taller");
  });
});
