---
description: Pantallas del área interna /taller, pensadas primero para tablet
paths:
  - "src/pages/taller/**"
  - "src/components/taller/**"
  - "src/layouts/TallerLayout.astro"
---

# Interfaz del taller

- Tablet primero: recepción, checklist, fotos, firma, orden de trabajo y control de calidad se diseñan para 820×1180 en vertical y con las manos sucias; el escritorio viene después. Catálogo, usuarios e informes son de escritorio.
- La recepción la hace cualquier rol, también el mecánico (FASE1 decisión 5): sus pantallas no se esconden al mecánico.
- Objetivos táctiles ≥ 48px de alto y de ancho en las pantallas de taller (botones, opciones del checklist, selects, enlaces de acción), separados al menos 8px.
- Nada que dependa de pasar el mouse por encima; nada que exija teclear párrafos: opciones tocables (`input type=radio` dentro de `label`), selects y campos cortos. Las notas son opcionales.
- Estados de orden con forma + texto: `<span class="status status--<estado>">` con un borde propio por estado (sólido, punteado, doble, rayado con `--hatch`) y la etiqueta de `STATUS_LABELS`. Nunca solo color.
- Tablas densas con `font-variant-numeric: tabular-nums`; montos con `formatClp`; números de orden con `formatOrderNumber` (`OT-00001`).
- Mismos tokens de `src/styles/global.css`; ningún hex nuevo; radio 2px, reglas de 1px, sin sombras. Los estilos comunes del área viven en `src/styles/taller.css`, importado por `src/layouts/TallerLayout.astro`, bajo la clase `.taller`; cada componente de `src/components/taller/` lleva los suyos en su propio `<style>` (scoped o `is:global` bajo `.taller`), y los que usa una sola página van en el `<style is:global>` de esa página, también bajo `.taller`; `global.css` no se toca.
- Las únicas islas del área son `src/components/taller/PhotoCapture.tsx` y `src/components/taller/SignaturePad.tsx`, con `client:load`. Todo lo demás es HTML del servidor con formularios POST que redirigen 303 a la misma página (`?hecho=…`).
- Las islas no importan `src/server/**`: reciben props y hablan con el servidor por `fetch` (fotos) o por un `input` oculto del formulario que las contiene (firma).
- Formularios con `label` visible; errores en texto con `aria-invalid`/`aria-describedby`; avisos de resultado con `role="status"`; grupos de opciones en `fieldset` con `legend` (los specs los ubican por ese nombre).
- Toda página empieza con sesión → permiso; los enlaces y botones se ocultan según `can(...)`, pero el servidor vuelve a revisar.
- Un solo `h1` por página; controles nativos (`button`, `a`, `label` + `input`), nunca `div` clicable.
- Fuera de la recepción, al mecánico no se le muestran teléfono, correo ni RUT del cliente.
