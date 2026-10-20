# Capa de publicación GEO por empresa

19 de octubre de 2026. Primera superficie para descubrimiento, separada de la
generación auxiliar por OpenAI. No usa claves API ni publica borradores generados.

```text
Desarrollo versionado → backend GEO → PostgreSQL (conocimiento autorizado)
                                         ↓
                         proyección pública de una sola empresa
                                         ↓
                    HTML + JSON + versión + sitemap + robots
                                         ↓
                    sitio / CMS / servidor → descubrimiento IA
```

## Contrato y límites

`publication.build_publication` lee `read_public_catalog(..., company_id=...)`.
Solo entran documentos vinculados a esa empresa y activos, con visibilidad pública
en documento y fragmento y ACL vacía en ambos. Una empresa sin material público
produce error; nunca cae en un catálogo global ni en los datos de demostración.
Las referencias requieren HTTP(S) sin credenciales. Una referencia local, `scw://`
o `demo://` impide construir el paquete completo. No se descargan esas URLs.

El HTML contiene exactamente el texto seleccionado y las fuentes; el marcado
arbitrario se escapa. No se infieren precios, servicios ni propiedades empresariales.
JSON-LD describe un Dataset sobre la empresa, no un perfil corporativo enriquecido
con hechos inventados. `knowledge.json` conserva IDs, texto y referencia de fuente.
La versión SHA-256 representa contenido y configuración; entradas idénticas
producen el mismo paquete. El manifest enumera hashes de los archivos de entrega.

El nombre público y la URL canónica se declaran explícitamente. La cabecera Host
no decide el dominio. No se debe adoptar un dominio ajeno como destino sin acceso
de despliegue. Para revisión local usar `http://127.0.0.1:8010/`.

## Vista local sin gasto de API

Con PostgreSQL y conocimiento de empresa ya importado:

```bash
cd ~/geo-engine
export DATABASE_URL=postgresql:///geo_engine
GEO_PORT=8010 .venv/bin/python -m geo_engine.cli serve-publication \
  --company dg_medios --name 'DG Medios' --base-url http://127.0.0.1:8010/
```

Abrir `http://127.0.0.1:8010/`. El servidor ofrece únicamente lecturas de
`index.html`, `knowledge.json`, `manifest.json`, `sitemap.xml` y `robots.txt`.
No expone endpoints de administración, datos de otras empresas ni ejecución IA.
Reconsulta PostgreSQL en cada petición con `Cache-Control: no-store`. Retirar o
restringir un documento cambia inmediatamente esa vista; si no queda conocimiento
público responde 404. Si falla PostgreSQL responde 503 sin reutilizar contenido.
El servidor estándar es solo para loopback local, no infraestructura productiva.

## Paquete para integración

```bash
.venv/bin/python -m geo_engine.cli publish-company \
  --company dg_medios --name 'DG Medios' --base-url https://example.com/geo/dg_medios/ \
  --output data/releases/dg_medios/release-001
```

La URL es de ejemplo: reemplazarla por el destino acordado antes de desplegar.
La salida debe ser nueva; no se sobrescriben releases ni archivos de un CMS.
Un error de escritura requiere desechar o revisar el release incompleto; nunca
activar el destino hasta completar la construcción y verificación de sus archivos.
El CMS/servidor debe servir HTML en la URL canónica y JSON en `knowledge.json`.
Copiar solo la salida, nunca el repositorio, claves o datos de PostgreSQL.

`robots.txt` es una propuesta de configuración para el dominio. En un sitio
existente se integra con sus reglas, no se reemplaza automáticamente su archivo.
El rastreador consulta robots en la raíz del dominio incluso al usar un prefijo.
El sitemap contiene la URL de la página HTML. La política inicial permite
`OAI-SearchBot` en la ruta y deniega `GPTBot` y otros rastreadores. La política
de entrenamiento y la de búsqueda son independientes según la
[documentación oficial de OpenAI](https://developers.openai.com/api/docs/bots).
No es un control de acceso para contenido confidencial.

## Actualizaciones y medición

La vista local refleja el estado autorizado vigente de la base. Un release estático
es una instantánea: tras modificar permisos o retirar evidencia hay que reconstruir
y reemplazar el release servido, retirando las versiones accesibles antiguas y
cachés. No se ha instalado un job ni conexión de despliegue GitHub/CMS.
La ingesta actual conserva historia: cambiar texto bajo un mismo ID genera conflicto;
la revisión del conocimiento y su versionado deben preceder a su publicación.

Pendiente para completar el canal real: dominio/hosting, integración en el sitio,
despliegue de releases aprobados, acceso HTTP externo y medición con consultas y
citas observadas. Tener archivos rastreables no confirma aparición ni recomendación
en ChatGPT. Las llamadas API internas con contexto inyectado tampoco la confirman.

No se copiaron registros internos de clientes al repositorio. DG Medios se usa con
la selección pública corroborada que el propietario solicitó y que reside fuera
del código. Las pruebas usan empresas y referencias HTTPS sintéticas.

Actualización del 20 de octubre: la ingesta estricta mantiene el rechazo de cambios
bajo un mismo ID; `--allow-revisions` permite versiones inmutables explícitas antes
del build. Ver [actualización controlada](ACTUALIZACION-CONOCIMIENTO.md).
