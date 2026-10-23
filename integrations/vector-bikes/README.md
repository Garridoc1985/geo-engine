# Vector Bikes

Sitio y reservas en línea del taller de bicicletas Vector Bikes (Av. Kennedy 7666, Vitacura): landing, reserva de horas, cancelación por enlace y panel `/admin`. Corre en Replit con Astro 7 y Postgres 16.

## Estado de producción

| Pieza | Estado |
|---|---|
| Sitio | En producción en **https://vectorbikes.cl**, publicado como Replit **Autoscale** Deployment. |
| Dominio | Registrado en **NIC Chile**; DNS administrado en el **cPanel de Bluehosting** (*Zone Editor*). |
| Conexión con Replit | Registro **A** `vectorbikes.cl → 34.111.179.208` y registro **TXT** `replit-verify=…`. El TXT es **permanente**: si se borra, falla la renovación del certificado SSL. |
| Correos automáticos | **Resend**, enviando desde `send.vectorbikes.cl` (registro DKIM y los CNAME `rsend.send` y `send.send` en cPanel). |
| Casilla del taller | `info@vectorbikes.cl` en **Microsoft 365**. Recibe los avisos de reservas nuevas y cancelaciones. |
| Antispam | **Cloudflare Turnstile** con claves reales, verificado en producción. |
| Panel admin | Operativo en `https://vectorbikes.cl/admin`, con agenda del día y vista de mes. Cuenta `info@vectorbikes.cl` creada en la base de producción. |
| Recordatorios por correo | Cron externo de **Make.com** → `POST /api/tareas/recordatorios` (ver *Recordatorios por correo (cron externo)*). |
| Recordatorios WhatsApp | **Opcionales**: requieren configuración de Meta y un cron externo (ver *Recordatorios*). |

## Operación diaria

Esta sección es para quien atiende el taller; no hace falta saber programar.

### Entrar al panel

1. Abre **https://vectorbikes.cl/admin/login**.
2. Ingresa con el correo `info@vectorbikes.cl` y la clave del panel.
3. Verás la agenda de hoy; desde ahí cambias a la vista de mes, revisas reservas, cambias su estado y bloqueas días u horarios.
4. Las reservas nunca se borran: si una no va, se cambia su estado (por ejemplo, a cancelada).

Si olvidas la clave, no hay botón de "recuperar": hay que cambiarla como se explica abajo.

### Cambiar la clave del panel

El dueño también puede restablecer las claves de otros usuarios en `/taller/usuarios`: escribe una clave nueva de al menos 12 caracteres y pulsa **Restablecer clave**. Se cierran las sesiones de ese usuario. Para cambiar tu propia clave o recuperar el acceso del dueño, usa el comando de abajo.

Se hace desde el workspace de la App en Replit (el editor, no el sitio publicado):

1. En Replit, abre la herramienta **Database**, cambia a la base de **producción** y copia su URL de conexión (empieza con `postgresql://`). Esa URL es secreta: no la pegues en correos, chats ni en el repositorio.
2. Abre la pestaña **Shell** y escribe, en una sola línea, reemplazando lo que está entre comillas:

   ```bash
   DATABASE_URL='<url de producción>' ADMIN_EMAIL='info@vectorbikes.cl' ADMIN_PASSWORD='<clave nueva>' pnpm admin:set-password
   ```

3. La clave debe tener 12 caracteres o más. Si todo sale bien, aparece `{"ok":true,…}`.
4. Cambiar la clave cierra todas las sesiones abiertas: vuelve a entrar en `/admin/login` con la nueva.

Sin el `DATABASE_URL` de producción delante, el comando cambia la clave de la base de **desarrollo**, no la del sitio real.

### Si el sitio deja de cargar

Revisa en este orden:

1. **Registro A en cPanel.** Entra al cPanel de Bluehosting → *Zone Editor* → `vectorbikes.cl` y confirma que existen:
   - **A** `vectorbikes.cl` → `34.111.179.208`
   - **TXT** `replit-verify=…`

   Es lo primero porque ya pasó: al configurar Microsoft 365, Bluehosting reescribió la zona y se perdieron el A de Replit y los CNAME de Resend. Si faltan, créalos de nuevo con los valores que muestra Replit en *Deployments → Settings → dominio*. Los cambios de DNS pueden tardar hasta unas horas en verse.
2. **Correos que no llegan.** En la misma zona, confirma el DKIM de Resend y los CNAME `rsend.send` y `send.send`; en Resend el dominio `send.vectorbikes.cl` debe aparecer *Verified*.
3. **Estado del servidor.** Abre `https://vectorbikes.cl/api/health`. Debe responder `{"ok":true,"db":true}`. Si responde pero `db` es `false`, el problema es la base; si no responde, revisa en Replit *Deployments* que la publicación esté activa y mira sus *Logs*.
4. **Aviso del navegador sobre el certificado.** Casi siempre es el TXT `replit-verify` borrado. Vuelve a crearlo.

Nunca toques los registros MX, SPF ni autodiscover de Microsoft 365: son los que hacen que `info@vectorbikes.cl` reciba correo.

## Operación del taller

### Acceso y equipo

Entra por `/admin/login` con tu correo y clave y abre `/taller`. También puedes abrir `/taller` directamente: si falta la sesión, el login te devuelve ahí. El mecánico entra al taller; dueño, administrador y recepción llegan por defecto a la agenda `/admin` y pueden pasar al taller.

Solo el dueño administra el equipo en `/taller/usuarios`: crea usuarios con nombre, correo, rol y clave inicial de 12 a 1024 caracteres. Desde la misma pantalla puede cambiar el rol, desactivar, reactivar y restablecer claves de otros usuarios. Desactivar o cambiar el rol revoca sus sesiones. No puedes modificar tu propio usuario ahí y debe quedar al menos un dueño activo en la sucursal.

### Reservas

Las reservas próximas están en `/taller/reservas`. Para cambiar el día o la hora de una, pulsa **Reprogramar**: elige el día, revisa los bloques libres y confirma. La reserva mantiene su código y su enlace de cancelación, así que el cliente sigue usando los mismos, y si tiene correo registrado recibe un aviso con el horario anterior, el nuevo y el calendario actualizado. Solo se reprograman reservas confirmadas que todavía no tienen orden de trabajo; si la bici ya se recibió, hay que cancelar y crear otra. Para cambiar la modalidad, la comuna o los datos del cliente también se cancela y se crea otra.

### Recepción en la tablet

La recepción la puede hacer cualquier rol, incluido el mecánico. El mecánico accede a sus órdenes y a las recepciones sin asignar en estado Reservada, Recibida o Diagnóstico.

1. Abre **Nueva recepción** en `/taller/recepcion/nueva`, o inicia la recepción desde una reserva en `/taller/reservas` para traer sus datos.
2. Busca al cliente por nombre, teléfono o RUT y usa su ficha y bicicleta. Si es nuevo, registra nombre y teléfono; correo y RUT son opcionales. Para una bicicleta nueva, completa marca, modelo y tipo. Escribe el servicio solicitado y pulsa **Crear orden**.
3. Completa todos los puntos del **Checklist**, anota observaciones y guarda. Registra los accesorios que quedan con la bici y agrega los servicios del catálogo; el precio corresponde al tipo de bicicleta. El mecánico puede agregar servicios del catálogo, pero no cambiar precios.
4. Revisa la fecha sugerida según la carga del taller y pulsa **Confirmar fecha** con la fecha acordada con el cliente.
5. Pulsa **Continuar a fotos y firma**. Toma al menos una foto de recepción y espera a que termine de subir. Pide la firma del cliente en la tablet y escribe el nombre de quien firma.
6. Pulsa **Finalizar recepción**. Solo se completa con checklist, foto, fecha confirmada y firma; la orden queda **Recibida**. Si faltan datos, la pantalla los indica.

Al finalizar la recepción, el cliente recibe un correo con el resumen si tiene correo registrado.

### Etiqueta y trabajo

Desde el detalle de la orden, abre **Etiqueta** y pulsa **Imprimir**. Selecciona la impresora de etiquetas con papel de **62 mm**, sin márgenes. La etiqueta lleva el número de orden, nombre del cliente, entrega estimada y QR; el QR abre la orden interna y requiere sesión. Haz una impresión de prueba para revisar el tamaño y la lectura antes de usarla en una bici.

En la orden se asigna el mecánico; un mecánico puede **Tomar orden** si está sin asignar y Recibida o en Diagnóstico. Registra el diagnóstico, cambia a los estados disponibles y usa **Galería** para las fotos de reparación y terminado. **Líneas** registra servicios y repuestos; **Componentes** conserva lo instalado y lo reemplazado en el historial de la bicicleta.

### Trabajos adicionales por WhatsApp

Dueño, administrador o recepción abren **Adicional**, escriben problema, recomendación y precio en pesos y pulsan **Crear propuesta**. Copia el enlace en ese momento o pulsa **Enviar por WhatsApp** y envía el mensaje desde WhatsApp. El cliente abre el enlace y aprueba o rechaza; la decisión queda registrada y el trabajo aprobado se agrega a la orden. Si necesitas otro enlace para una propuesta pendiente, pulsa **Generar nuevo enlace**: el anterior deja de servir. El mecánico no propone adicionales ni modifica precios.

### Control de calidad

Al terminar la reparación, pasa la orden a **Control de calidad** y abre esa pantalla en la tablet. Solo el dueño puede registrar la revisión: marca **OK** o **Falla** en todos los puntos, anota lo necesario y pulsa **Aprobar control**. Si todo está OK, queda **Lista para retirar**; si hay una falla, vuelve a **En reparación** y conserva el historial. Actualmente se permite el autocontrol del dueño y queda identificado en el historial.
Al aprobar el control, se avisa al cliente por correo si tiene un correo registrado.

### Pagos y entrega

Dueño, administrador o recepción abren **Entrega** para registrar un abono o pago final, con método transferencia, tarjeta, efectivo u otro, y monto entero en pesos. Solo puede haber un abono vigente; el monto no puede superar el saldo. Dueño y administrador pueden anular pagos antes de entregar.

Cuando la orden esté **Lista para retirar**, registra el pago pendiente hasta dejar saldo cero. Pide la firma de quien retira, confirma su nombre y pulsa **Entregar bicicleta**. La entrega exige saldo cero y firma; queda **Entregada**. La pantalla registra los pagos recibidos en el taller.

### Informe e historial

Dueño, administrador o recepción pueden abrir **Informe** cuando la orden esté Lista para retirar o Entregada. Revisa las recomendaciones sugeridas por los servicios, completa **Próximas revisiones** y pulsa **Generar informe**. Copia el enlace que aparece una sola vez o envíalo por WhatsApp. El cliente ve bicicleta, trabajo, problemas, componentes, fotos de antes y después, recomendaciones, trabajos rechazados y total. Regenerar el informe actualiza su contenido e invalida el enlace anterior. Las fichas de cliente y bicicleta conservan su historial.

### Garantía

En una orden **Entregada**, dueño, administrador o recepción pueden escribir el motivo y pulsar **Abrir garantía**. Se crea otra orden para el mismo cliente y bicicleta, vinculada a la original, y se abre su recepción. Completa nuevamente checklist, fotos, fecha y firma; la orden original se conserva.

### Si falla una foto

Espera el resultado de la subida. Si aparece **No se pudo subir la foto. Intenta de nuevo.**, revisa la conexión y vuelve a seleccionarla. El límite es **15 MB por foto** y el archivo debe ser una imagen. Si seleccionaste varias y una falla, recarga la galería para comprobar cuáles quedaron guardadas antes de reintentar las pendientes. La recepción exige al menos una foto guardada. Conviene subir las fotos antes de firmar: una subida exitosa recarga la página.

### Tareas diarias y respaldos

El escenario de **Make.com** se configura para las **10:00**, zona **America/Santiago**, y encadena tres llamadas POST: `/api/tareas/recordatorios`, `/api/tareas/alertas` y `/api/tareas/retencion`, con `Authorization: Bearer <TASKS_SECRET>`. El secreto va en Make.com y en los secretos de la publicación. Configura un aviso al dueño ante respuestas fallidas; los detalles están en **Recordatorios por correo (cron externo)**.

Recordatorios envía los correos del día anterior; alertas manda al taller el resumen de órdenes atrasadas y debe llamarse una sola vez al día. Retención elimina las copias completas de fotos de recepción de más de seis meses y conserva las miniaturas para el historial e informe. Las fotos de reparación y terminado se conservan. La integración opcional de recordatorios WhatsApp tiene su propio cron, descrito en **Recordatorios**.

Confirma en el panel **Database** de Replit que los respaldos programados de la base estén activos y revisa sus puntos de restauración. Las fotos y firmas están en almacenamiento separado: respalda también ese almacenamiento junto con la base. La aplicación no programa respaldos; esa configuración se administra en la plataforma.

## Publicar

1. Corre `pnpm gate` en el workspace y confirma que sale 0.
2. **Borra `node_modules` antes de cada Publish:** `rm -rf node_modules`. El instalador de Replit falla si la carpeta existe.
3. *Deployments → Autoscale → Publish*.
4. Al terminar, comprueba `https://vectorbikes.cl/api/health`.

Para seguir trabajando en el workspace después de publicar, reinstala con `pnpm install --frozen-lockfile`.

## Pendientes

- **Recordatorios WhatsApp.** La integración directa opcional con Meta Cloud API se activa solo al configurarla; el endpoint protegido debe llamarlo un cron externo de **Make.com** (ver *Recordatorios*). No se ejecuta un cron interno de la app.
- **Rotar la credencial de la base de producción.** La contraseña de la base de producción no ha sido rotada desde el lanzamiento. Tras rotarla hay que actualizar el `DATABASE_URL` en los secretos de la deployment y volver a publicar.
- **Feriados 2027.** Ver *Configuración de producción → Feriados 2027*.

## Desarrollo

Requisitos: Node 24 (`.nvmrc`; mínimo 22.12) y pnpm 12.4.2 activado con corepack.

`package.json` no lleva el campo `packageManager`: Replit lo reescribe al publicar y, si existe, su instalación con pnpm 10 intenta autoinstalar pnpm 12 y aborta. La versión se fija donde manda, en el `build` de `[deployment]` en `.replit` (`corepack pnpm@12.4.2 …`); no vuelvas a agregar el campo.

1. En la Replit App elige **Node.js 24** en el selector de lenguaje/módulo.
2. Activa pnpm: `corepack enable` (con `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`) y comprueba `pnpm --version` → `12.4.2`.
3. Instala: `pnpm install --frozen-lockfile`.
4. Copia `.env.example` a `.env`. En Replit los valores reales van en *Secrets* y tienen precedencia sobre `.env`. En desarrollo usa `EMAIL_TRANSPORT=console` y las claves de prueba de Turnstile.
5. Levanta el servidor: `pnpm dev` → http://localhost:4321.
6. Crea la cuenta del panel: `ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm admin:set-password` (clave de 12 caracteres o más; volver a ejecutarlo cambia la clave y cierra las sesiones abiertas).

Antes de publicar o de dar una tarea por terminada, la compuerta debe pasar:

```bash
pnpm gate   # check + test + build + test:build + smoke
```

`pnpm ci` no sirve: es un comando propio de pnpm.

## Base de datos

- Crea la base en la herramienta *Database* del workspace de Replit; Replit define `DATABASE_URL`.
- El esquema vive en `src/server/db/schema.ts`. Después de cambiarlo:
  - `pnpm db:generate` genera la migración en `drizzle/` (nunca se edita a mano).
  - `pnpm db:migrate` la aplica. **Solo contra la base del workspace.**
  - `pnpm db:check` confirma que están todas las tablas.
- Al publicar, Replit propaga el esquema a la base de producción. La app nunca migra al arrancar y `db:migrate` jamás se ejecuta contra producción.
- Las reservas nunca se borran: se cambia su `status`.

## Recordatorios por correo (cron externo)

El recordatorio del día anterior a cada reserva lo dispara un escenario de **Make.com**, no una Scheduled Deployment (Replit no permitió una segunda publicación en la misma App).

- Programación: diaria a las **10:00**, zona **America/Santiago**.
- Llamada: módulo HTTP, `POST https://vectorbikes.cl/api/tareas/recordatorios`, cabecera `Authorization: Bearer <TASKS_SECRET>`, sin cuerpo, timeout de 120 segundos.
- `TASKS_SECRET` (mínimo 32 caracteres; genéralo con `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`) va en los *Secrets* de la Autoscale Deployment y en Make.com, nunca en el repositorio.
- Respuesta esperada: HTTP 200 con `{"ok":true,"sent":n}`. Cualquier otra (401, 500 o `"ok":false`) debe disparar el aviso por correo al dueño que se configura en el mismo escenario.
- Llamarlo dos veces el mismo día no duplica correos: cada reserva queda marcada con `reminder_sent_at`.
- Respaldo manual: `pnpm reminders:send` sigue existiendo y hace lo mismo desde el Shell de Replit con el `DATABASE_URL` de producción.

El mismo escenario de Make.com encadena, después del primero, `POST https://vectorbikes.cl/api/tareas/alertas` (correo diario al taller con las órdenes atrasadas; cada llamada envía un resumen, por eso se llama una sola vez al día) y `POST https://vectorbikes.cl/api/tareas/retencion` (borra las copias completas de fotos de recepción con más de 6 meses y conserva las miniaturas; repetirla no hace nada), con la misma cabecera.

## Recordatorios

La integración directa con **WhatsApp Business Cloud API de Meta** es opcional. Los correos de reserva y notificación al taller siguen siendo independientes: un fallo o la desactivación de WhatsApp no los sustituye ni los desactiva.

### Preparación de Meta

1. En Meta Business, configura/verifica el negocio y completa la configuración de WhatsApp Business Platform (Cloud API).
2. Asocia y verifica un número de teléfono de empresa. Usa el **Phone Number ID** de ese número, no el número visible, como `WHATSAPP_PHONE_NUMBER_ID`.
3. Genera un token de acceso de sistema adecuado para producción y guárdalo como secreto `WHATSAPP_ACCESS_TOKEN`. No lo pongas en el navegador, en código, ni en el repositorio.
4. En WhatsApp Manager, crea las plantillas de categoría correspondiente y espera la aprobación de Meta antes de enviar. Configura los nombres aprobados en `WHATSAPP_REMINDER_TEMPLATE` y `WHATSAPP_READY_TEMPLATE`, y el idioma disponible/aprobado en `WHATSAPP_TEMPLATE_LANGUAGE` (por defecto `es_CL`). Los parámetros del cuerpo deben ser posicionales y mantener este orden:
   - Recordatorio: `{{1}}` nombre, `{{2}}` fecha `dd/MM/yyyy`, `{{3}}` hora de Santiago `HH:mm`, `{{4}}` código de reserva.
   - Bicicleta lista: `{{1}}` nombre, `{{2}}` bicicleta, `{{3}}` código.
   - Ejemplo de recordatorio: «Hola {{1}}, te recordamos tu reserva del {{2}} a las {{3}}. Código: {{4}}».
   - Ejemplo de bicicleta lista: «Hola {{1}}, tu bicicleta {{2}} está lista para retirar. Reserva: {{3}}».
5. En los secretos del entorno donde corre la app, configura `WHATSAPP_ENABLED=true`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` (por defecto `v23.0`) y los nombres/idioma exactos de las plantillas aprobadas. Mantén `WHATSAPP_ENABLED=false` mientras falte cualquier requisito. No agregues ninguna de estas credenciales al cliente.
6. El consentimiento para WhatsApp aplica únicamente a reservas nuevas en las que el cliente lo otorgue. No se debe asumir ni activar consentimiento para reservas anteriores.

### Cron externo de recordatorios

Un cron externo de **Make.com** debe llamar cada 15 minutos. Procesa reservas confirmadas que empiezan dentro de las próximas 24 horas y aún no recibieron WhatsApp, incluyendo reservas hechas el mismo día; usa `America/Santiago` para las fechas y horas del mensaje:

```http
POST /api/internal/whatsapp-reminders
Authorization: Bearer <CRON_SECRET>
```

Configura `CRON_SECRET` como secreto privado de al menos 32 caracteres; el mismo valor va en el encabezado de Make.com. No lo expongas en el cliente ni en logs o URL. En Make.com usa el módulo HTTP, método POST, programación cada 15 minutos en zona `America/Santiago` y un timeout de 180 segundos. El endpoint devuelve un resumen de envíos `sent`, `failed` y `skipped`. No configures un cron interno ni una Scheduled Deployment para esta tarea.

Si una llamada termina con timeout o resultado desconocido, no la reintentes a ciegas: primero verifica el resultado/estado de los envíos para evitar duplicados. Un error de respuesta no demuestra que Meta no haya aceptado el mensaje. La fila queda bloqueada en `unknown` (o `sending` si se interrumpió el proceso) y no se reenvía automáticamente. Tras dos minutos, el panel permite conciliar un envío interrumpido, pero exige confirmar que el proceso/ejecución cron terminó o fue detenido: el tiempo transcurrido por sí solo no basta. Registra la evidencia de verificación y el `wamid` si fue aceptado. Solo confirma «no aceptado» con evidencia real, nunca por un timeout; esto habilita un reintento seguro. La API de Meta no ofrece una clave de idempotencia de envío: no es posible garantizar exactamente una entrega tras una respuesta perdida sin verificar el resultado externo. `sent` significa aceptado por Meta, no necesariamente leído o entregado al dispositivo.

En el detalle de cualquier reserva confirmada, **Bicicleta lista — enviar WhatsApp** cambia el estado a `ready_for_pickup` y después intenta el aviso. Un fallo no revierte el estado; el panel muestra el resultado y permite reintentar rechazos confirmados. Puede completarse una reserva lista. Los recordatorios y avisos de bicicleta lista tienen filas únicas e independientes por reserva/tipo; los campos del correo no se reutilizan.

Antes de activar en producción, aplica `pnpm db:migrate` y ejecuta `pnpm db:check` en desarrollo: verifica tablas, columnas y la restricción del estado `ready_for_pickup`. Después publica los cambios de aplicación/esquema y confirma que el esquema requerido llegó a la base de producción mediante la propagación de esquema de Replit. No ejecutes `pnpm db:migrate` contra producción; confirma allí las columnas/tablas requeridas antes de habilitar los envíos.

`pnpm reminders:send` es un comando existente separado; no configura ni programa este envío por WhatsApp y no sustituye el endpoint ni el cron externo.

## Configuración de producción (referencia)

Registro de cómo se montó producción. Ya está hecho; sirve para rehacerlo si algo se pierde.

### 1. Publicar la Autoscale Deployment

1. Corre `pnpm gate` en el workspace y confirma que sale 0, y borra `node_modules`.
2. *Deployments → Autoscale → Publish*. Replit usa el bloque `[deployment]` de `.replit`: build `corepack pnpm@12.4.2 install --frozen-lockfile --config.minimumReleaseAge=0 && corepack pnpm@12.4.2 build` y run `HOST=0.0.0.0 PORT=4321 node dist/server/entry.mjs`.

### 2. Secretos de producción

Se cargan en los secretos de la Autoscale Deployment; ninguno va al repositorio:

- `DATABASE_URL` (la de producción)
- `PUBLIC_SITE_URL=https://vectorbikes.cl`
- `PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
- `SESSION_SECRET`, `CANCEL_TOKEN_SECRET` (≥ 32 caracteres; genera cada una con `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`)
- `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`
- `EMAIL_FROM=Vector Bikes <reservas@send.vectorbikes.cl>`, `EMAIL_REPLY_TO=info@vectorbikes.cl`, `SHOP_NOTIFY_EMAIL=info@vectorbikes.cl`
- `PUBLIC_WHATSAPP_NUMBER` si existe
- Para habilitar la integración opcional de WhatsApp, configura también los secretos `WHATSAPP_ENABLED=true`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`, `WHATSAPP_REMINDER_TEMPLATE`, `WHATSAPP_READY_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE` y `CRON_SECRET` (mínimo 32 caracteres), siguiendo *Recordatorios*. No uses valores reales en `.env.example` ni los guardes en el repositorio.

Las variables `PUBLIC_*` se hornean en el build: después de cambiarlas hay que volver a publicar.

### 3. Esquema de producción

Confirma que `pnpm db:check` sale `{"ok":true,...}` en desarrollo y que esas tablas aparecen en el panel *Database* de producción. La app nunca migra ni se corre `pnpm db:migrate` contra producción.

### 4. Cuenta admin en producción

En el shell, con el `DATABASE_URL` de producción exportado solo para ese comando:

```bash
DATABASE_URL='<url de producción>' ADMIN_EMAIL='…' ADMIN_PASSWORD='…' pnpm admin:set-password
```

Luego entra en `https://vectorbikes.cl/admin/login` y confirma que `/admin` muestra la agenda de hoy.

### 5. Dominio (cPanel de Bluehosting)

1. En Replit: *Deployments → Settings → Link a domain* → `vectorbikes.cl`.
2. En cPanel → *Zone Editor*, crea exactamente los registros **A** y **TXT `replit-verify=…`** que entrega Replit.
3. **No borres nunca el TXT `replit-verify`**: Replit lo usa para renovar el certificado SSL.
4. Comprueba que `https://vectorbikes.cl/api/health` responde `{"ok":true,"db":true}` con certificado válido.

### 6. Correo con Resend

1. En Resend, agrega el dominio `send.vectorbikes.cl`.
2. En cPanel crea exactamente los registros que muestre Resend para ese subdominio (DKIM y los CNAME `rsend.send` y `send.send`).
3. **No toques los registros MX, SPF ni autodiscover de Microsoft 365** del dominio principal: `info@vectorbikes.cl` debe seguir recibiendo correo. Compruébalo enviando un correo externo a ese buzón.
4. Haz una reserva real: el cliente debe recibir la confirmación con el `.ics` y el taller el aviso, sin caer en spam. Cancélala con el enlace y confirma que llega el aviso de cancelación.

### 7. Turnstile real

1. En Cloudflare → *Turnstile*, crea el widget para `vectorbikes.cl`.
2. Reemplaza las claves de prueba por `PUBLIC_TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY` reales y vuelve a publicar.

### 8. WhatsApp

Define `PUBLIC_WHATSAPP_NUMBER` en los secretos de la Autoscale Deployment y **vuelve a publicar** (el número se hornea en el build). Si queda vacío, el botón no aparece.

### 9. Supresión de datos

Cuando alguien pida eliminar sus datos a info@vectorbikes.cl, anonimiza su reserva desde el panel *Database* de producción. La fila no se borra:

```sql
update bookings
set customer_name = '(eliminado)',
    phone_e164 = '+56900000000',
    email = 'eliminado@vectorbikes.cl',
    bike = '-',
    description = '-',
    address = case when mode = 'retiro' then '(eliminado)' else null end,
    ip_hash = null
where id = '<id>';
```

### 10. Feriados 2027

Antes de diciembre de 2026 (el panel lo advierte cuando el horizonte de 30 días llega a 2027), carga los feriados oficiales de 2027 con la skill `add-holidays`, corre `pnpm gate`, haz commit y vuelve a publicar. Nunca inventes fechas: usa solo las oficiales.
