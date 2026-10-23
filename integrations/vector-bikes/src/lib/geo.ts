import { existsSync } from "node:fs";

// Se evalúa al construir la portada. Instalar el paquete antes de pnpm build.
export const geoAvailable = existsSync("public/geo/index.html");
