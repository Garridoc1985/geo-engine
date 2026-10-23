# Publicación e IA en tiempo real — avance del 23 de octubre de 2026

## Estado

Implementación local, todavía sin conectar ni publicar. El usuario confirmó ambos
flujos y eligió https://github.com/Garridoc1985/geo-engine como repositorio.
El repositorio existe y la conexión GitHub permite administrarlo. Su carpeta
`integrations` solo contiene README.md: el código del sitio aún no está allí.
La copia local tampoco tiene commits ni remoto. No conectar Netlify a una ruta
que todavía no existe en main; primero preparar una rama revisable con la importación.

El despliegue actual continúa protegido con HTTP 401. No hay garantía de indexación
ni conexión real del asistente. La página del asistente no se enlazó desde la portada.

## Archivos preparados

- `.github/workflows/vectorbikes-public-access.yml`: verificación manual o tras un
  estado de despliegue exitoso de producción, cuando Netlify publique ese evento.
- `scripts/check-public-site.mjs`: verifica acceso anónimo, canonical, robots,
  sitemap y noindex. Sale con error si falla; detectó correctamente el 401 actual.
- `integrations/vector-bikes/netlify/functions/assistant.mts`: ruta POST
  `/api/asistente`, límite de cinco peticiones por minuto por IP y dominio.
- `integrations/vector-bikes/src/server/assistant.ts`: SDK oficial OpenAI,
  Responses API en SSE, instrucciones basadas en datos aprobados, sin acceso a
  reservas o base de datos. Máximo 800 caracteres de pregunta, cuerpo 4 KiB,
  salida 600 tokens, plazo 45 segundos, cancelación y errores sin detalles internos.
- `integrations/vector-bikes/src/lib/env.ts`: interruptor apagado por defecto.
- `integrations/vector-bikes/src/public-test/pages/asistente.astro`: interfaz
  con detener, estados de error, aviso sobre IA y derivación al taller. Texto
  insertado como texto plano; no interpreta HTML del proveedor. Página noindex.
- `integrations/vector-bikes/tests/unit/assistant.test.ts`: pruebas aisladas sin red.
- `package.json` y `pnpm-lock.yaml` del sitio: dependencia oficial openai 7.42.0.

Las instrucciones del modelo reducen errores pero no garantizan fidelidad factual;
la calidad se debe evaluar con preguntas reales antes de habilitarlo.

## Conexión de publicación pendiente

1. Importar solamente el código necesario en una rama de geo-engine; excluir .env,
   .netlify, almacenamiento, node_modules, archivos temporales y datos operativos.
2. Validar y revisar los cambios antes de fusionarlos. La compuerta completa del
   backend sigue pendiente por el fallo nativo de V8/PGlite ya documentado. El usuario
   excluyó tablet de las pruebas; no se modificaron los comandos para ocultar fallos.
3. En Netlify, vincular GitHub y el repositorio elegido; base directory
   `integrations/vector-bikes`. Usar su netlify.toml existente, publicación
   `dist-public-test`, funciones en `netlify/functions` y Node 24.
4. Mantener la aprobación del responsable: previews para revisión y publicación de
   producción únicamente tras su aprobación. Comprobar la configuración real de
   auto-publicación; un archivo de workflow no crea un requisito de aprobación.
5. Resolver visibilidad Public y ejecutar `node scripts/check-public-site.mjs`.

## Conexión del proveedor de IA pendiente

- Comprobar AI Features y la disponibilidad de modelos del AI Gateway en la cuenta.
  No se pudo consultar el catálogo público mediante la herramienta web; no se eligió
  ni se probó ningún modelo real.
- Configurar `AI_MODEL` en el ámbito Functions con un modelo disponible en la cuenta.
- AI Gateway inyecta `OPENAI_API_KEY` y `OPENAI_BASE_URL` en tiempo de ejecución;
  el SDK los consume. No incluir credenciales en el navegador ni en el repositorio.
- Con `AI_ASSISTANT_ENABLED` ausente o distinto de `true`, responde 503 sin
  consumir IA. Habilitar solo después de revisar el resultado y el consumo previsto.
- El ZIP estático usado previamente no contiene funciones: se requiere despliegue
  con compilación de funciones (Git/CLI), no simplemente subir dist-public-test.
- Probar stream en un preview con acceso permitido, cancelación, interrupción,
  errores 429/502/503 y preguntas sin respuesta respaldada por el código.
- Actualizar la política de privacidad antes de abrir el asistente al público.
- No se efectuaron llamadas reales al modelo ni se verificó consumo de créditos.

## Validación realizada

- pnpm format: correcto, advertencias CSS ya existentes.
- pnpm check: correcto, 0 errores de Astro; hints previos presentes.
- Build estático: correcto, genera cuatro páginas incluida /asistente/.
- Pruebas unitarias iniciales del asistente: 6/6 correctas con proveedor simulado.
- Verificación pública: falla por HTTP 401, como corresponde al bloqueo actual.
- Sin prueba visual en laptop de la página nueva ni prueba real de extremo a extremo.
- No se da por terminada la integración ni la compuerta completa del proyecto.

## Referencias oficiales

- https://developers.openai.com/api/docs/guides/streaming-responses
- https://docs.netlify.com/build/ai-gateway/overview/
- https://docs.netlify.com/build/functions/overview/
