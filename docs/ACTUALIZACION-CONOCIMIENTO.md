# Actualización controlada del conocimiento

20 de octubre de 2026.

`ingest-company` conserva su modo estricto: cambiar título, texto o fuente bajo
un ID existente rechaza la transacción. Para incorporar una selección editorial
revisada con cambios, se habilita explícitamente:

```bash
.venv/bin/python -m geo_engine.cli ingest-company EMPRESA --workspace RUTA --allow-revisions
```

La entrada es un snapshot completo de la empresa, no un parche. Los registros
omitidos quedan inactivos; un snapshot vacío retira toda la selección activa.
La revisión se identifica con SHA-256 de título, texto y referencia de fuente.
El ID original se conserva como prefijo. Permisos y ACL no forman parte del hash:
cambiar permisos actualiza el acceso a la misma revisión. Las fuentes, documentos
y fragmentos anteriores se conservan, y solo el snapshot importado queda activo.
Repetir una carga idéntica reutiliza las revisiones sin duplicarlas. Reimportar
una versión anterior la reactiva con los permisos declarados en esa importación.
Cambiar del modo estricto al modo de revisiones crea una primera versión con hash,
aunque el contenido no haya cambiado. No se mezclan ni migran IDs históricos.

La escritura y activación son una sola transacción PostgreSQL bajo el bloqueo de
ingesta existente. Las salidas públicas y la recuperación excluyen documentos
inactivos; la finalización de borradores también verifica su vigencia.
El flag expresa una operación local explícita; no acredita revisión editorial
ni implementa un sistema de aprobadores o autenticación.

Tras la ingesta, construir un directorio de release nuevo con `publish-integration`
y revisar sus archivos antes de instalarlo en el sitio/CMS. Un release estático
anterior permanece igual hasta reemplazarlo y retirar versiones/cachés anteriores.
Vector Bikes tiene Durable como destino previsto; este cambio no conecta Durable,
no publica remotamente ni instala un job automático. La sincronización automática,
vectorización y Graphify continúan pendientes.
