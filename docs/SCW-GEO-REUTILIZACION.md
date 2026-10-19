# Inicio de GEO Engine con SCW como referencia

Fecha: 19 de octubre de 2026.
Estado: evaluación de lectura; plan de implementación local. No modifica SCW.

## Decisión de trabajo

GEO Engine continúa como proyecto independiente en Ubuntu con PostgreSQL.
SCW aporta antecedentes de organización del conocimiento y trazabilidad. No se
copia el repositorio completo ni se importan datos reales de sus clientes.
No se ha integrado ni ejecutado su pipeline en GEO Engine.

## Qué se revisó y qué se reutiliza

| Superficie SCW | Hallazgo | Aplicación en GEO |
| --- | --- | --- |
| README y main.py | Herramienta interna de diagnóstico y propuestas; entrada por terminal | Conservar separación de responsabilidades; API GEO propia |
| src/organizational_intelligence.py | Evidencias con ID, ruta, estado y contenido; contexto concatenado | Adoptar procedencia explícita; construir recuperación por consulta y permisos |
| Plantilla evidence_registry.md | Registro manual; ID, fuente, fecha, confianza y estado | Usar como referencia de trazabilidad; no confundir confianza declarada con suficiencia verificada |
| src/pipeline.py | Secuencia orientada a diagnóstico y propuesta | Reutilizar el patrón de etapas; escribir un recorrido GEO específico |
| requirements.txt | Clientes de Anthropic/OpenAI y configuración | Evaluar adaptadores cuando se decida proveedor; no añadir llamadas de IA ahora |
| PROJECT_STATE.md | client_execution, implement_code:false y freeze activo | Mantener SCW como referencia de lectura en este trabajo |

No se afirma que SCW tenga una API GEO, recuperación por fragmentos, ACL operativas
o persistencia PostgreSQL: esas capacidades deben implementarse y comprobarse aquí.
La lectura de código no equivale a una prueba de ejecución de SCW.

## Primer incremento: ingesta y persistencia

Sigue los puntos de ingesta y persistencia del sprint existente, sin reordenarlo.

1. Definir un registro de producto/servicio que pueda expresarse en JSON, CSV y catálogo.
2. Validar campos obligatorios, IDs únicos y permisos antes de escribir.
3. Transformar cada registro en fuente, documento y fragmento con IDs estables.
4. Guardar el lote en una transacción PostgreSQL; un error no deja una carga parcial.
5. Probar recarga sin duplicados, datos inválidos y conservación de procedencia y ACL.
6. Exponer inicialmente una entrada por terminal en Ubuntu; conectar después la API
   autenticada. No crear un endpoint anónimo de escritura de datos empresariales.

### Formato inicial propuesto

| Campo | Significado |
| --- | --- |
| id | Identificador estable dentro del catálogo de demostración |
| kind | product o service |
| title | Nombre de la oferta |
| description | Descripción respaldada por la fuente |
| source_reference | Referencia de origen; demo:// únicamente para fixtures sintéticos |
| visibility | public o internal |
| allowed_principals | Lista de identidades autorizadas; en CSV, lista JSON en una celda |

La ingesta deberá rechazar visibilidades desconocidas, ACL mal formadas y referencias
vacías. Un documento interno no se transforma en público por omitir permisos.
El formato inicial es para una empresa de demostración: antes de datos de varias
empresas se debe agregar aislamiento por organización a contratos, consultas y base.

### Evidencia de aceptación del incremento

- Cargar los 10 registros sintéticos de `fixtures/catalog.demo.json` en PostgreSQL.
- Repetir la carga sin duplicar documentos ni fragmentos.
- Verificar que los registros internos mantienen sus ACL.
- Rechazar un lote inválido completo y comprobar que no dejó registros parciales.
- Ejecutar todo desde Ubuntu sin usar claves de IA ni datos reales.

El fixture por sí solo no prueba la ingesta; las pruebas de integración verifican
su persistencia y recarga, las ACL y la reversión del lote ante fallos.
Los dos borradores y la suficiencia de evidencia se validan en los siguientes puntos.

## Avance del primer incremento — 19 de octubre de 2026

Implementados `catalog.py` y `cli.py`: lectura JSON/CSV, catálogo en memoria,
validación previa, IDs estables, persistencia transaccional y detección de recargas
y conflictos. Se conservan fuentes y ACL sin sobrescribir ofertas existentes.
16 pruebas aprobadas en Ubuntu contra PostgreSQL, incluyendo fallo de restricción
SQL con rollback, conflicto después de una inserción y lote inválido sin escrituras.
No se ejecutan llamadas de IA ni se usan registros de clientes de SCW.

## Fuentes revisadas

- https://github.com/Garridoc1985/smart-business-decision-support-workspace/blob/master/README.md
- https://github.com/Garridoc1985/smart-business-decision-support-workspace/blob/master/src/organizational_intelligence.py
- https://github.com/Garridoc1985/smart-business-decision-support-workspace/blob/master/src/pipeline.py
- https://github.com/Garridoc1985/smart-business-decision-support-workspace/blob/master/organizational_intelligence/templates/evidence_registry.md
- https://github.com/Garridoc1985/smart-business-decision-support-workspace/blob/master/.governance/PROJECT_STATE.md
