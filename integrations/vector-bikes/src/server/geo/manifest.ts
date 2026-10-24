import { isIP } from "node:net";
import { z } from "zod";

export const websiteSelection = z.object({
  website: z.string().trim().url().max(2048),
  pages: z.string().max(20000),
  authorized: z.literal("yes"),
});

function publicPage(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /\.(local|localhost|internal|test|invalid|lan|home)$/.test(host)
  ) {
    throw new Error("Usa páginas HTTPS de un dominio público, sin parámetros ni credenciales.");
  }
  const decoded = decodeURIComponent(url.pathname).toLowerCase();
  if (
    /(^|\/)(admin|taller|api|reservas|aprobacion|informe|clientes|usuarios)(\/|$)/.test(decoded)
  ) {
    throw new Error("Selecciona solo páginas públicas; excluye reservas y operación del taller.");
  }
  return url;
}

export function buildWebsiteManifest(input: z.infer<typeof websiteSelection>) {
  const website = publicPage(input.website);
  const entries = input.pages
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const urls = [...new Set([website.href, ...entries.map((value) => publicPage(value).href)])];
  if (urls.length > 50) throw new Error("Selecciona un máximo de 50 páginas.");
  if (urls.some((value) => new URL(value).origin !== website.origin)) {
    throw new Error("Todas las páginas deben pertenecer al mismo sitio.");
  }
  return {
    company_id: "vectorbikes",
    pages: urls.map((url, index) => ({
      url,
      title:
        index === 0 ? "Vector Bikes - sitio público" : `Vector Bikes - ${new URL(url).pathname}`,
      public_authorized: true,
    })),
  };
}
