# Desarrollo de GEO Engine sobre la base de SCW

## Primer recorrido operativo

El cargador empresarial de SCW se adapta en `geo_engine/company_knowledge.py` y
se integra con el runtime de GEO Engine. El archivo original de `reference/scw`
se mantiene como antecedente de procedencia; ya no es la única forma de reutilización.

```text
clients/<empresa>/company_profile.md
clients/<empresa>/products_services.md
clients/<empresa>/evidence_registry.md → evidence/*.md
                      ↓
               CompanyKnowledge
                      ↓
       PostgreSQL: empresa, documentos y fragmentos
                      ↓
          recuperación pública por empresa
                      ↓
          router Claude → ChatGPT → otras IA futuras
```

Se reutiliza la estructura de conocimiento empresarial y registro de evidencias
de SCW. Los dominios heredados siguen admitidos y los registros retirados se excluyen.
La carga es transaccional e idempotente: recargar lo mismo no duplica y un contenido
distinto con el mismo ID produce un conflicto sin sobrescribir el conocimiento.
Cada carga representa el conjunto vigente completo de esa empresa: los registros
retirados o ausentes se desactivan sin borrar historia. Las nuevas declaraciones
de acceso actualizan permisos; los documentos inactivos quedan fuera del catálogo,
la recuperación y el guardado de nuevos borradores. Una carga vacía desactiva todo
el conocimiento de esa empresa; una carga fallida revierte el lote completo.

## Ejecutar la demostración en Ubuntu

Desde la raíz del proyecto, con PostgreSQL y el entorno Python preparados:

```bash
.venv/bin/python -m geo_engine.cli ingest-company demo_company --workspace fixtures/scw_demo
.venv/bin/python -m geo_engine.cli route "mantenimiento predictivo" --company demo_company --origin perplexity
```

La primera orden importa el perfil, productos/servicios, contexto interno y evidencia
vigente de una empresa ficticia. La segunda recupera sólo información pública de
esa empresa y planifica el proveedor de generación sin consumir APIs.
`--origin perplexity` solo etiqueta el buscador de origen; no lo selecciona como
proveedor ni implementa una conexión de búsqueda.
Sin modelos y credenciales configurados, conserva las fuentes y devuelve `no_provider`.
Con los proveedores configurados se puede ejecutar usando la opción existente
`--execute`, que puede generar cargos y no se utilizó para la demostración.

API local existente:

```bash
curl --fail http://127.0.0.1:8000/v1/router/plan \
  -H 'Content-Type: application/json' \
  -d '{"query":"mantenimiento predictivo","company_id":"demo_company","origin":"claude"}'
```

La empresa se conserva en el registro de ejecución. Una consulta con empresa
explícita no recupera documentos de otra. La ausencia del filtro conserva el
comportamiento anterior de búsqueda sobre el conocimiento público disponible.

## Acceso a documentos de la empresa

`access.json` junto a los Markdown declara permisos por ruta relativa:

```json
{
  "products_services.md": {
    "visibility": "public",
    "allowed_principals": [],
    "source_reference": "https://example.com/productos"
  }
}
```

Un archivo sin declaración se importa como interno con ACL vacía; no se vuelve
público por estar en el repositorio. Los archivos internos se conservan en PostgreSQL
y no entran al contexto del router público. Las referencias sin una URL declarada
usan `scw://<empresa>/<ruta>` para mantener procedencia; no son páginas web publicadas.
El cargador no descarga enlaces ni lee fuera de la carpeta de esa empresa.
Esta versión admite hasta 20000 caracteres por documento y rechaza archivos de
más de 200000 bytes antes de leerlos. La fragmentación de documentos mayores es
un incremento posterior; no se recortan silenciosamente.

Este incremento usa datos sintéticos. No se trasladaron documentos de clientes de
SCW. No se desarrolló el módulo de revisión de citas que el propietario descartó.

## Continuidad del desarrollo

La base empresarial está conectada al router. Los siguientes incrementos del
producto deben trabajar sobre ese recorrido: adaptación del pipeline de negocio a
tareas GEO, formatos de entrega para agentes y publicación de información autorizada.
La conexión real de proveedores sigue dependiendo de claves y modelos de las cuentas.

Validación: 78 pruebas aprobadas en Ubuntu/PostgreSQL. Incluyen carga SCW, dominios,
permisos, rutas, retiro de registros, recarga, aislamiento por empresa y el recorrido
hasta el router y el borrador persistido con un proveedor simulado.
