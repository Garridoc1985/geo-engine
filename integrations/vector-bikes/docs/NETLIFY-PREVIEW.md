# Vista previa de Vector Bikes

Configuración revisada el 23 de octubre de 2026.

- Proyecto: `vectorbikestestgeo`, repositorio `Garridoc1985/geo-engine`.
- Producción conserva la rama `main`; la publicación automática está bloqueada
  mediante `Auto Publishing Locked`, para conservar la aprobación del responsable.
- Rama adicional habilitada: `codex/vectorbikes-publication-stream`.
- Base: `integrations/vector-bikes`.
- Build: `corepack pnpm@12.4.2 exec astro build --config astro.public-test.config.mjs`.
- Publish relativo a la base: `dist-public-test`.
- Funciones relativas a la base: `netlify/functions`.

El build estático publica las páginas públicas y la función `assistant` por separado;
no publica el backend de reservas o taller. El asistente permanece apagado salvo
que `AI_ASSISTANT_ENABLED=true`, exista `AI_MODEL` y el proveedor esté configurado
en el servidor. No incorporar claves ni valores privados en este documento.

La primera validación debe confirmar en Netlify la compilación de la función,
la página `/asistente/` y el manejo de servicio no habilitado sin consumir IA.
Después se valida el modelo real en un entorno de revisión antes de habilitarlo.

El proyecto continúa con visibilidad Private heredada del equipo. La opción Public
aparece deshabilitada en el panel; no se cambió ni se intentó eludir ese control.
La vista previa tampoco se considera accesible sin sesión hasta comprobarlo.

El éxito de este build no equivale a aprobación de producción ni a validación de
la compuerta completa del backend, que continúa pendiente. No se ejecutan pruebas
de tablet por instrucción del responsable.
