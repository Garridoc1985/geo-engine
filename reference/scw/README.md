# Componentes de referencia de GEO Engine

Se conserva el cargador de evidencia del workspace de origen como referencia para
una futura adaptación. No forma parte del runtime activo ni se carga por la API.
No se copiaron datos de clientes, claves, canon comercial ni reglas de gobernanza.

Origen: https://github.com/Garridoc1985/smart-business-decision-support-workspace
Commit de origen: 40618cc53dbe5599844b6352334228474f883710
Archivo: src/organizational_intelligence.py

Modificación local: nombres de producto sustituidos por GEO Engine.
Antes de activarlo se deben adaptar rutas, aislamiento por empresa, permisos y
selección de evidencia. No ejecutar `crear_cliente` sobre datos de producción.

Las plantillas trasladadas a `knowledge/templates` mantienen convenciones del
workspace original; sus referencias RFC son antecedentes, no normas de este proyecto.

La adaptación operativa está en `geo_engine/company_knowledge.py` y se conecta a
PostgreSQL y al router. Ver `docs/DESARROLLO-SOBRE-SCW.md`; este original de referencia
permanece sin ejecutarse directamente.
