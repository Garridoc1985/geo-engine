import { existsSync } from "node:fs";
import node from "@astrojs/node";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || "https://vectorbikes.cl",
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    preact(),
    sitemap({
      customPages: existsSync("public/geo/index.html")
        ? [new URL("/geo/", process.env.PUBLIC_SITE_URL || "https://vectorbikes.cl").href]
        : [],
      // Lista blanca a propósito: solo entran las páginas públicas que nombramos
      // aquí. Con una lista negra, cada ruta nueva se publicaba sola (así se
      // colaron 8 rutas de /taller al sitemap de producción).
      filter: (page) =>
        ["/", "/privacidad", "/geo", "/servicios"].includes(
          new URL(page).pathname.replace(/\/$/, "") || "/",
        ),
    }),
  ],
  security: {
    checkOrigin: false,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
