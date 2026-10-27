import { defineConfig } from "astro/config";
import baseConfig, { createSiteIntegrations } from "./astro.config.mjs";
import { validateRelease } from "./scripts/geo-install.mjs";

// Rechaza un release incompleto o alterado antes de compilar la versión pública.
validateRelease("public/geo", "https://vectorbikestest.cl");

// Solo páginas públicas; las rutas operativas no forman parte de este build.
export default defineConfig({
  ...baseConfig,
  site: "https://vectorbikestest.cl",
  srcDir: "./src/public-test",
  output: "static",
  adapter: undefined,
  outDir: "./dist-public-test",
  integrations: [
    ...createSiteIntegrations("https://vectorbikestest.cl", true),
    {
      name: "public-site-indexing",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await writeFile(
            new URL("robots.txt", dir),
            "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /taller\nDisallow: /api\nDisallow: /reservas\nDisallow: /aprobacion\nDisallow: /informe\n\nSitemap: https://vectorbikestest.cl/sitemap-index.xml\nSitemap: https://vectorbikestest.cl/geo/sitemap.xml\n",
          );
          await writeFile(new URL("_headers", dir), "/*\n  X-Content-Type-Options: nosniff\n");
        },
      },
    },
  ],
});
import { writeFile } from "node:fs/promises";
