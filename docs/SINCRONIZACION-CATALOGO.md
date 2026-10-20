# Sincronización de snapshots web por fuente

20 de octubre de 2026. `sync-catalog` sincroniza conocimiento local en PostgreSQL;
no publica remotamente, no programa jobs y no vuelve a consultar la web.

## Flujo

1. Capturar la lista completa de URLs autorizadas con `read-public-web`, siempre
   en un directorio nuevo. El lector escribe `snapshot.json` al final, con empresa,
   número de registros y hash determinista de contenido, fuentes y permisos.
2. Revisar el snapshot. Si es necesario cambiar la captura, corregir el manifiesto
   o la fuente y regenerar. No editar los archivos del snapshot después del cierre.
3. Previsualizar las diferencias del ámbito elegido.
4. Aplicar el mismo snapshot revisado.
5. Construir un release nuevo con `publish-integration`; el despliegue sigue pendiente.

```bash
.venv/bin/python -m geo_engine.cli read-public-web \
  --manifest /ruta/pages.json --output /ruta/captura-002

.venv/bin/python -m geo_engine.cli sync-catalog \
  --company empresa --scope website --workspace /ruta/captura-002

.venv/bin/python -m geo_engine.cli sync-catalog \
  --company empresa --scope website --workspace /ruta/captura-002 \
  --expect-version HASH_DEVUELTO_EN_LA_PREVISUALIZACION --apply
```

El scope debe mantenerse estable entre capturas. Un nuevo nombre crea otra fuente;
no renombra ni retira automáticamente la anterior. Empresa y scope aceptan letras
minúsculas, números, guion y guion bajo, hasta 64 caracteres.

## Contrato y aislamiento

La entrada es el snapshot completo de una fuente, no de toda la empresa. La clave
operativa es empresa + scope. Los IDs usan el prefijo `sync:<empresa>:<scope>:` y
revisiones SHA-256 del contenido y fuente. No se requiere una migración de esquema.
La sincronización activa exactamente los registros del snapshot de ese ámbito y
retira de la selección activa las versiones anteriores o URLs omitidas. Conserva
los documentos históricos y las referencias de fuentes. No altera registros SCW,
otros scopes, el catálogo global ni otras empresas. `ingest-company` opera ahora
solo sobre su prefijo `scw:<empresa>:` y conserva los ámbitos sincronizados.

El comando rechaza snapshots vacíos, sin comprobante, modificados o de otra empresa,
registros internos y URLs ajenas al contrato del lector público. Los hashes detectan
inconsistencia; no son firmas ni acreditan identidad o revisión editorial. Snapshots
anteriores a este incremento deben capturarse nuevamente para obtener el comprobante.
Si antes se importó una captura WEB mediante ingest-company, esos registros siguen
en el ámbito SCW: no se migran ni eliminan automáticamente. Revisar esa selección
por separado para evitar duplicar contenido al crear un scope nuevo.

Sin `--apply`, ejecuta la transacción de prueba bajo el bloqueo de ingesta y la
revierte: no persisten empresas, contenido, permisos ni activaciones. La CLI puede
inicializar el esquema vacío de desarrollo. Con `--apply`, las escrituras y los
retiros se confirman juntos. Un error revierte la operación completa. No hay red
ni APIs IA en esta operación. La captura de red precede y está separada de la
transacción para no mantener bloqueos durante lecturas externas.

La respuesta incluye status preview/applied, content_version, processed, imported,
existing, activated, deactivated, permissions_changed y changed. `imported` cuenta
revisiones nunca almacenadas; reactivar una revisión histórica puede dar imported=0
con activated>0. Repetir un snapshot activo idéntico devuelve changed=false.
La previsualización es informativa: otra operación puede cambiar la base antes del
apply. El apply recalcula las diferencias bajo bloqueo. `--expect-version` exige
el hash de la entrada aprobada; no es un bloqueo optimista sobre la versión previa
de PostgreSQL. Reaplicar una captura antigua puede reactivar una revisión histórica.

## Retiro completo explícito

Una captura fallida no significa que la fuente esté vacía. Para retirar todo el
contenido de un ámbito se requiere una operación distinta:

```bash
.venv/bin/python -m geo_engine.cli sync-catalog \
  --company empresa --scope website --clear

.venv/bin/python -m geo_engine.cli sync-catalog \
  --company empresa --scope website --clear --apply
```

No usar `--clear` para tratar errores HTTP o páginas temporalmente inaccesibles.
Una URL omitida deliberadamente en una captura completa se retira de ese ámbito.
Los retiros en PostgreSQL no eliminan releases estáticos ya desplegados: es necesario
reconstruir, sustituir y retirar las versiones/cachés públicas anteriores.

## Pendientes

Scheduler periódico, aprobación editorial autenticada, auditoría persistente de cada
sincronización, adaptador WordPress, despliegue y comprobación pública. El scope es
un aislamiento operativo local, no un mecanismo de autenticación o autorización.
Durable sigue como destino particular previsto para Vector Bikes.
