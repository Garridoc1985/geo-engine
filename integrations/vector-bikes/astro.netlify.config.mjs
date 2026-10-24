import netlify from "@astrojs/netlify";
import { defineConfig } from "astro/config";
import baseConfig from "./astro.config.mjs";

// Configuración exclusiva de Netlify. El desarrollo y las pruebas conservan Node.
export default defineConfig({
  ...baseConfig,
  adapter: netlify(),
});
