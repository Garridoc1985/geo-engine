# Privacidad del asistente público

Revisión del 23 de octubre de 2026 para el PR #3.

El aviso de `src/public-test/pages/privacidad.astro` describe el sitio informativo y el
asistente opcional, sin importar el aviso de reservas del backend operativo. El
formulario identifica a OpenAI y Netlify y enlaza al aviso antes de consultar.
El pie compartido remite al aviso sin afirmar que el único uso sea una reserva.

Verificado contra el código: se envían una pregunta y las instrucciones con datos
públicos, sin historial; no se persisten conversaciones en la aplicación; la
función pide `store: false`; Netlify aplica el límite por IP y dominio. No se afirma
retención cero, residencia geográfica ni cumplimiento legal certificado.

Fuentes oficiales consultadas:

- https://docs.netlify.com/build/build-with-ai/security-and-privacy-for-ai-features/
- https://developers.openai.com/api/docs/guides/your-data

Netlify documenta que AI Gateway no almacena prompts ni respuestas normalmente,
pero sí metadatos y permite registros ampliados bajo solicitud. OpenAI distingue
estado de aplicación de registros de prevención de abuso: `store: false` no es una
garantía general de ausencia de conservación. El aviso enlaza ambos documentos.

El cambio se prepara para evaluación en Deploy Preview. No habilita IA en
producción, no cambia variables de entorno y no fusiona la rama principal.
La compuerta completa del backend sigue pendiente por el fallo nativo V8/PGlite
registrado previamente; las comprobaciones públicas no la sustituyen. Tablet
excluida por instrucción del propietario; no se modificó `gate`.
