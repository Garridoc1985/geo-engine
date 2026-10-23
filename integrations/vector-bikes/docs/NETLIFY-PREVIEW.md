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

El responsable autorizó cambiar la política del equipo a Private for new projects
y hacer públicos producción y Deploy Previews de este proyecto. El panel confirmó
ambos como Public. La verificación funcional se realiza con la sesión abierta del
navegador por instrucción del responsable; no equivale a verificar acceso anónimo.

Producción publicó la corrección estática 6adbc4a12881ea936692ea62. Esta rama añade
la página de evaluación y la función del asistente para una prueba separada, sin
reemplazar esa producción. Las vistas previas públicas no garantizan indexación.

El éxito de este build no equivale a aprobación de producción ni a validación de
la compuerta completa del backend, que continúa pendiente. No se ejecutan pruebas
de tablet por instrucción del responsable.
