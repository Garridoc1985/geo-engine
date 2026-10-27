import { existsSync } from "node:fs";
import node from "@astrojs/node";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// El build operativo y el sitio público de prueba tienen listas explícitas distintas.
export function createSiteIntegrations(site, publicTest = false) {
  const allowed = publicTest ? ["/", "/privacidad", "/geo", "/servicios"] : ["/", "/privacidad"];
  return [
    preact(),
    sitemap({
      customPages:
        publicTest && existsSync("public/geo/index.html") ? [new URL("/geo/", site).href] : [],
      // Lista blanca a propósito: solo entran las páginas públicas que nombramos
      // aquí. Con una lista negra, cada ruta nueva se publicaba sola (así se
      // colaron 8 rutas de /taller al sitemap de producción).
      filter: (page) => allowed.includes(new URL(page).pathname.replace(/\/$/, "") || "/"),
    }),
  ];
}

const site = process.env.PUBLIC_SITE_URL || "https://vectorbikes.cl";
export default defineConfig({
  site,
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: createSiteIntegrations(site),
  security: {
    checkOrigin: false,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
