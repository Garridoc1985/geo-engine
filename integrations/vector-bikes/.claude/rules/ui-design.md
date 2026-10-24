---
description: Fidelidad al diseño aprobado y accesibilidad de la interfaz
paths:
  - "src/components/**"
  - "src/layouts/**"
  - "src/styles/**"
  - "src/pages/*.astro"
---

# Interfaz

- `docs/design-preview.html` manda: clases, textos y estructura se copian de ahí; las únicas diferencias permitidas están en `blueprint.md` §6.
- Colores solo con variables de `:root` (`--ground`, `--surface`, `--ink`, `--ink-2`, `--steel`, `--rule`, `--hatch`, `--on-ink`, `--field-border`); ningún hex nuevo.
- Radio 2px, reglas de 1px, sin sombras (salvo `inset 0 0 0 1px var(--ink)` de selección).
- Botón primario invierte en hover (fondo `--surface`, texto y borde `--ink`); enlaces de nav con `:not(.btn)`.
- Formularios: `label` visible con `for`, `.fields{align-items:start}`, `.field{align-content:start}`, errores en texto con `aria-invalid` y `aria-describedby`.
- Un solo `h1` por página, niveles sin saltos; controles nativos (`button`, `a`, `details`), nunca `div` clicable.
- Transiciones con `var(--dur-fast)`/`var(--dur)`; sin `!important`.
- En el sitio público, una sola isla (`BookingIsland`, `client:visible`); todo lo demás es HTML estático. El área `/taller` tiene sus propias reglas en `.claude/rules/taller-ui.md`.
- WhatsApp: si `PUBLIC_WHATSAPP_NUMBER` está vacío, el botón no se renderiza.
- Etiquetas no-void siempre cerradas (Astro 7).
