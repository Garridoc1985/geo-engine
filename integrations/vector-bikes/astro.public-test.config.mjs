import { defineConfig } from "astro/config";
import baseConfig from "./astro.config.mjs";

// Solo páginas públicas; las rutas operativas no forman parte de este build.
export default defineConfig({
  ...baseConfig,
  site: "https://vectorbikestest.cl",
  srcDir: "./src/public-test",
  output: "static",
  adapter: undefined,
  outDir: "./dist-public-test",
  integrations: [
    ...baseConfig.integrations,
    {
      name: "public-site-indexing",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await writeFile(
            new URL("robots.txt", dir),
            "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /taller\nDisallow: /api\nDisallow: /reservas\nDisallow: /aprobacion\nDisallow: /informe\n\nSitemap: https://vectorbikestest.cl/sitemap-index.xml\n",
          );
          await writeFile(new URL("_headers", dir), "/*\n  X-Content-Type-Options: nosniff\n");
        },
      },
    },
  ],
});
import { writeFile } from "node:fs/promises";
