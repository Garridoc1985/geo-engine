# GEO Engine — Inteligencia Comercial y GEO

El producto es una capa de publicación de conocimiento empresarial para visibilidad
en respuestas de IA, comenzando por ChatGPT. La generación con OpenAI es una
herramienta auxiliar. Ya existe una [superficie de publicación por empresa](docs/PUBLICACION-GEO.md)
en HTML/JSON, con procedencia y permisos, exportable a sitio/CMS/servidor.
La vista local se actualiza desde PostgreSQL por petición; el despliegue externo
y la medición de citas quedan pendientes. No es un producto de SEO o Google Ads.

Para integrar en un sitio/CMS existente hay un paquete con fragmentos HTML visibles,
metadatos y datos públicos. `publish-integration` exige destino HTTPS explícito y
no instala cambios remotamente. [Uso e instalación](docs/INTEGRACION-WEB-GEO.md).

Repositorio: https://github.com/Garridoc1985/geo-engine (privado, rama `main`).

GEO Engine prepara información empresarial verificable para consumo por sistemas
de IA como Claude y ChatGPT, y por canales de descubrimiento como el buscador
Perplexity. En el producto, Perplexity no es un proveedor de generación y su canal
de búsqueda todavía no tiene conexión activa. Desarrollo y evolución de arquitectura
habilitados: [definición vigente](docs/PRODUCTO-Y-ARQUITECTURA.md).
El objetivo es distribución y recuperación por IA; la base inicial no representa
todavía una integración activa de descubrimiento con esos sistemas y canales.

Base ARQ-01 del Sprint 01, preparada para Ubuntu 24.04 y Python 3.12+.
Usa PostgreSQL y Psycopg 3; no requiere proveedor de IA todavía.

Repositorio independiente con estructura inspirada en el workspace de origen:
`geo_engine/` (runtime), `knowledge/templates/` (plantillas), `integrations/`
(adaptadores futuros), `reference/scw/` (cargador de evidencia de referencia),
`docs/`, `fixtures/` y `tests/`. Procedencia en `reference/scw/README.md`.

La estructura de conocimiento empresarial de SCW ya tiene un adaptador operativo
en el runtime: [desarrollo sobre SCW](docs/DESARROLLO-SOBRE-SCW.md).

## Ejecutar en Ubuntu

Instalar PostgreSQL y preparar la base local una sola vez. Los comandos de creación
presuponen que el rol y la base aún no existen:

```bash
sudo apt update
sudo apt install postgresql python3-venv
sudo service postgresql start
sudo -u postgres createuser "$USER"
sudo -u postgres createdb --owner="$USER" geo_engine
```

Desde WSL, usar el clon de trabajo en el directorio personal:

```bash
cd ~/geo-engine
python3 -m venv .venv
.venv/bin/python -m pip install -e .
export DATABASE_URL=postgresql:///geo_engine
.venv/bin/python -m geo_engine.api
```

En otra terminal Ubuntu:

```bash
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8000/ready
GEO_TEST_DATABASE_URL=postgresql:///geo_engine .venv/bin/python -m unittest discover -s tests -v
```

Detener con Ctrl+C. PostgreSQL conserva los datos en su almacenamiento de Ubuntu.
La conexión local usa socket Unix y autenticación peer, sin contraseñas en archivos.
Las pruebas crean y eliminan un esquema único por caso; el rol necesita permiso
CREATE sobre la base. Sin GEO_TEST_DATABASE_URL, esas pruebas se omiten. Usar una
base local de desarrollo, nunca producción.
La configuración usa variables de entorno; `.env` no se carga automáticamente.

```bash
export GEO_HOST=127.0.0.1
export GEO_PORT=8000
export DATABASE_URL=postgresql:///geo_engine
```

## Arquitectura y contratos

- `contracts.py`: fuentes, documentos, fragmentos, permisos, consultas, evidencia y resultados.
- `storage.py`: esquema PostgreSQL versión 1 y comprobación de disponibilidad.
- `persistence.py`: interfaz de escritura atómica de documentos y resultados.
- `ingestion.py`: interfaz de ingesta CSV, JSON y catálogo.
- `catalog.py`: validación de catálogos y persistencia transaccional en PostgreSQL.
- `cli.py`: entrada de importación desde terminal Ubuntu.
- `retrieval.py`: recuperación textual PostgreSQL de evidencia pública.
- `router.py`: planificación y ejecución con prioridad Claude → ChatGPT → otras IA futuras.
- `pipeline.py`: interpretación de tareas GEO y preparación de contexto y formato.
- `providers.py`: adaptadores HTTP y configuración por entorno.
- `runs.py`: registro PostgreSQL de ejecuciones, borradores y fuentes.
- `company_knowledge.py`: carga del perfil, dominios y evidencias con estructura SCW.
- `company_store.py`: persistencia de conocimiento y vinculación por empresa.
- `generation.py`: interfaz de generación y evaluación de suficiencia.
- `api.py`: arranque y rutas GET `/health` y `/ready`.

La fuente tiene un identificador y una referencia. El documento apunta a la fuente;
el fragmento apunta al documento; los resultados guardan referencias a los fragmentos.
La referencia de fuente de un fragmento se obtiene a través del documento.
El adaptador de ingesta deberá verificar la coherencia de esos identificadores.

Las ACL son listas de identidades permitidas. La recuperación deberá exigir que
tanto el documento como el fragmento permitan acceso. La identidad deberá proceder
de autenticación validada por el servidor, nunca de una identidad libre enviada por
el cliente. Un borrador público solo podrá usar evidencia pública, aunque el usuario
tenga acceso a documentos internos. Las referencias también deben respetar permisos.

## Alcance y decisiones

Python y PostgreSQL son la base local; PostgreSQL fue solicitado por el usuario.
Los permisos usan arrays TEXT[] y las fechas TIMESTAMPTZ. La inicialización del
esquema es transaccional.
El servidor HTTP estándar solo se usa en loopback para desarrollo local.
No es un servidor de producción ni una API con autenticación implementada.

ARQ-01 deja backend ejecutable, esquema, contratos y puertos de módulos.
La ingesta de catálogo JSON/CSV tiene implementación local con persistencia.
La recuperación pública y el router tienen implementación y pruebas con proveedores
simulados. La ejecución real requiere claves y modelos configurados por entorno.
Los borradores generados y sus fuentes se persisten junto al registro de ejecución.
Los 2 borradores revisados con proveedor real y el recorrido completo del sprint
quedan pendientes; el acceso a información interna no está habilitado en el router.

Antes de exponer datos: implementar autenticación, persistencia y recuperación con
ACL, validación de ingesta, evaluación de suficiencia, generación y pruebas del flujo.
La directiva vigente habilita desarrollar publicación, descubrimiento y medición;
el alcance anterior del sprint queda como antecedente.

Pendiente de decisión: proveedor/modelo de generación, criterio de suficiencia,
autenticación e infraestructura de despliegue. No se requiere resolverlos para
ejecutar esta base local. El backlog original de 16 funcionalidades no fue aportado;
se usa el documento de continuidad como referencia parcial sin reordenarlo.

Controlador: [instalación oficial de Psycopg 3](https://www.psycopg.org/psycopg3/docs/basic/install.html).

Arquitectura, contratos y cierre de criterios: [ARQ-01](docs/ARQ-01.md).

Inicio con SCW como referencia: [mapa de reutilización y primer incremento](docs/SCW-GEO-REUTILIZACION.md).
`fixtures/catalog.demo.json` contiene 10 registros totalmente ficticios para
las pruebas de ingesta y conservación de permisos.

## Importar JSON, CSV o catálogo

Desde la raíz del proyecto en Ubuntu, con PostgreSQL iniciado:

```bash
export DATABASE_URL=postgresql:///geo_engine
.venv/bin/python -m geo_engine.cli ingest fixtures/catalog.demo.json
```

Resultado inicial: `{"processed": 10, "imported": 10, "unchanged": 0}`.
Al repetir: `{"processed": 10, "imported": 0, "unchanged": 10}`.
Un ID existente con contenido diferente rechaza todo el lote, sin sobrescribir.
La actualización de ofertas requiere un flujo posterior explícito de revisión.

JSON es una lista de objetos con estos campos obligatorios:
`id`, `kind`, `title`, `description`, `source_reference`, `visibility`,
`allowed_principals`. CSV usa los mismos encabezados y una lista JSON en la celda
`allowed_principals` (el escritor CSV debe escapar sus comillas).
También se admite un catálogo en memoria mediante `catalog.import_catalog`.

`kind` admite `product` o `service`; `visibility`, `public` o `internal`.
Los permisos son obligatorios: una ACL interna vacía deniega todo acceso y no
convierte el registro en público. Un registro público requiere una lista vacía.
Los campos desconocidos y los IDs duplicados dentro del lote se rechazan.
Los IDs aceptan letras ASCII, números, punto, guion y guion bajo, hasta 128 caracteres.
El contenido textual de cada campo está limitado a 20000 caracteres.

Cada oferta genera una fuente, un documento y un fragmento con IDs estables
`catalog:<id>:source`, `catalog:<id>:document` y `catalog:<id>:chunk:1`.
El fragmento conserva nombre, tipo y descripción; su fuente se obtiene mediante el
documento. Las escrituras son atómicas y las recargas idénticas no duplican datos.
Los permisos se conservan en la ingesta y la recuperación del router excluye los
registros internos. El catálogo JSON/CSV inicial es global; la importación SCW
vincula el conocimiento a una empresa y permite consultarlo por `company_id`.

## Catálogo para consumidores IA — primera salida local

`GET /v1/public/catalog` devuelve JSON con documentos y fragmentos públicos,
sus identificadores y referencias. Excluye contenido interno en ambas capas.

```bash
curl --fail http://127.0.0.1:8000/v1/public/catalog
```

Con los fixtures hay 8 entradas públicas. Es una superficie local de desarrollo;
no conecta proveedores ni publica el catálogo sintético en Internet.

## Router de IA

```bash
.venv/bin/python -m geo_engine.cli route "diagnóstico comercial" --origin perplexity
```

Planifica sin llamadas externas. `--origin perplexity` etiqueta el buscador de
origen; no selecciona proveedor ni ejecuta una búsqueda. Para generar se necesitan
claves/modelos y la opción explícita `--execute`. [Contrato, configuración y límites](docs/ROUTER.md).

Para revisar un registro local, usar el ID devuelto:

```bash
.venv/bin/python -m geo_engine.cli show-run ID_UUID_DE_LA_EJECUCION
```

## Conocimiento empresarial basado en SCW

```bash
.venv/bin/python -m geo_engine.cli ingest-company demo_company --workspace fixtures/scw_demo
.venv/bin/python -m geo_engine.cli route "mantenimiento predictivo" --company demo_company --origin perplexity
```

Importa conocimiento con la estructura `clients/<empresa>/` y lo conecta al router.
El fixture es ficticio; los documentos sin permiso público explícito permanecen
internos. [Estructura, acceso y recorrido](docs/DESARROLLO-SOBRE-SCW.md).

## Pipeline GEO — paso 5

```bash
.venv/bin/python -m geo_engine.cli geo "Prepara preguntas frecuentes" --company demo_company --task faq
```

Interpreta la tarea, recupera conocimiento SCW de la empresa y prepara el contexto
para el router. Admite respuesta directa, perfil, catálogo, FAQ y contenido GEO.
El modo predeterminado no consume APIs. [Flujo y contrato](docs/PIPELINE-GEO.md).

El flujo pasó 110 pruebas con ChatGPT simulado y PostgreSQL. Las pruebas
automatizadas continúan sin llamadas externas.
[Alcance de esa validación](docs/PRUEBAS-CHATGPT-SIN-API.md).

## Inicio de integración API — paso 6

La etapa vigente conecta primero OpenAI mediante el adaptador `chatgpt`.
`--provider chatgpt` aísla ese proveedor sin cambiar la prioridad general del router.

```bash
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt --list-models
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt --check-access
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt --check-generation
```

El primero solo revisa configuración; el segundo lista modelos visibles para la
clave API. El tercero consulta el acceso al modelo elegido. El cuarto hace una
generación sintética de prueba y puede generar cargos. Ninguno requiere PostgreSQL.
La conexión y generación real ya se validaron manualmente en Ubuntu.
Las pruebas automatizadas usan transporte simulado y no consumen APIs reales.
[Configuración y primera ejecución](docs/INTEGRACION-OPENAI.md).

## Actualización controlada

La ingesta admite revisiones inmutables explícitas con `ingest-company --allow-revisions`.
Conserva historia y activa el snapshot completo importado, sin publicar remotamente.
[Contrato y uso](docs/ACTUALIZACION-CONOCIMIENTO.md).

## Estado de entrega — 20 de octubre de 2026

Suite local: 176 pruebas aprobadas con PostgreSQL, sin APIs externas.
`sync-catalog` ya permite sincronizar snapshots web completos por empresa y fuente,
con previsualización, integridad y aplicación transaccional explícita.
[Contrato y uso](docs/SINCRONIZACION-CATALOGO.md). El contrato anterior para
snapshots empresariales es `company_store.import_company(..., allow_revisions=True)`:
recibe una tupla completa de `KnowledgeRecord` por empresa; omitir registros los
retira de la selección activa. No entregar un snapshot parcial tras un fallo de
lectura, porque retiraría registros válidos. La CLI correspondiente es
`ingest-company --workspace RUTA --allow-revisions`, que carga la estructura SCW.

El lector `read-public-web` captura URLs públicas expresamente autorizadas y
prepara un snapshot SCW para revisión, conservando fuentes y excluyendo rutas
de clientes, órdenes y usuarios. No necesita el código del sitio ni escribe
automáticamente en PostgreSQL. [Contrato y uso](docs/LECTOR-WEB-PUBLICA.md).
WordPress es el primer adaptador de publicación previsto; Durable es el destino
particular previsto para Vector Bikes. Ninguno tiene despliegue automático activo.


## Sincronizar actualizaciones web

Capturar con `read-public-web`, revisar y ejecutar `sync-catalog --company EMPRESA
--scope website --workspace RUTA`. Por defecto previsualiza; `--apply` confirma.
Conserva el conocimiento manual y otras fuentes. No publica ni instala un scheduler.
Los snapshots deben incluir el comprobante `snapshot.json` generado por el lector.
