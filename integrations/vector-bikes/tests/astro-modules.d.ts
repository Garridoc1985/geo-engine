// `tsc` no resuelve `.astro` por sí solo (lo hace `astro check`); los tests que renderizan
// componentes con el Container API necesitan este tipo.
declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";
  const component: AstroComponentFactory;
  export default component;
}
