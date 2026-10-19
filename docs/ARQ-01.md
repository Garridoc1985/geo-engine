# ARQ-01 — Base técnica local

Nota del 19 de octubre de 2026: registro del alcance inicial. La directiva
`PRODUCTO-Y-ARQUITECTURA.md` habilita evolución arquitectónica y define el producto
como infraestructura de conocimiento consumida por IA; prevalece sobre este alcance.

Fecha: 19 de octubre de 2026. Plataforma objetivo: Ubuntu 24.04 mediante WSL2.

## Contexto revisado

La carpeta inicial Postulaciones no era un repositorio. El usuario confirmó que
debía crearse la base y solicitó PostgreSQL. Se inicializó `geo-engine` como repo
independiente; no había convenciones ni pruebas previas que conservar.
No hay remoto GitHub configurado ni commits todavía.

## Decisión de arquitectura

Python 3.12, Psycopg 3 y PostgreSQL 16. El servidor HTTP estándar ofrece únicamente
diagnóstico local. No hay dependencia de un proveedor de IA ni secretos en fixtures.
El código está en la unidad Windows montada en Ubuntu; PostgreSQL y sus datos
residen en Ubuntu. El entorno `.venv` se crea y ejecuta exclusivamente en Ubuntu.

Flujo contractual:

```text
API → ingesta → persistencia PostgreSQL
API → recuperación con permisos → generación/evaluación → persistencia de resultado
```

Solo el arranque API → inicialización PostgreSQL → diagnóstico está implementado.
Los demás módulos definen interfaces para desarrollar el flujo sin cambiar contratos.

| Módulo | Entrada | Salida / obligación |
| --- | --- | --- |
| Ingesta | Fuente, documento y fragmentos | Validación previa y delegación a persistencia |
| Persistencia | Fuente, documento, fragmentos o resultado | Escritura atómica y referencias íntegras |
| Recuperación | Consulta e identidad autenticada | Evidencias autorizadas con IDs y fuentes |
| Generación/evaluación | Consulta y evidencias | Resultado con estado y referencias |
| API local | GET /health, GET /ready | Estado de proceso y disponibilidad del esquema |

## Reglas entre módulos

- Fuente: ID estable, referencia y título. Documento: ID, fuente y permisos.
- Fragmento: ID, documento, fuente, contenido y permisos. La ingesta deberá validar
  que su fuente coincide con la del documento; PostgreSQL deriva esa fuente del documento.
- Recuperación: autorizar documento y fragmento antes de construir `Evidence`.
- Identidad: se obtendrá de autenticación validada; no se confiará en texto del cliente.
- Salida pública GEO: solo evidencia pública, aunque el usuario pueda leer datos internos.
- Resultado: conservar IDs de fragmentos y referencias de fuente; cuando la evidencia
  no alcance, usar `insufficient_evidence` y mostrar «información insuficiente».
- ACL: la política del contrato está probada; su aplicación en recuperación y generación
  pertenece a los siguientes puntos del sprint y aún no está implementada.

## Criterios de aceptación

| Criterio ARQ-01 | Evidencia |
| --- | --- |
| Revisar estructura antes de modificar | Carpeta inicial inspeccionada; base nueva autorizada |
| Backend local ejecutable | `python -m geo_engine.api`; integración HTTP real contra PostgreSQL |
| Contratos de documentos, fragmentos, fuentes, permisos, consultas y resultados | `geo_engine/contracts.py` |
| IDs y fuentes transportables por módulos | `Evidence`, `Result` y puertos de ingesta, persistencia, recuperación y generación |
| Sin secretos ni datos reales | Conexión local peer; fixtures sintéticos; `.env` ignorado |
| Comandos de arranque y pruebas documentados | README, con instalación y configuración Ubuntu |

## Pendientes fuera del cierre ARQ-01

Implementar ingesta CSV/JSON/catálogo, repositorios, recuperación autorizada,
generación/evaluación y endpoints funcionales. Luego demostrar 10 productos y
2 borradores con los casos con evidencia, sin evidencia y exclusión por permisos.
No se considera completado el Sprint 01.

Decisiones pendientes: proveedor de generación, criterio de suficiencia, autenticación
y despliegue. El backlog completo de 16 funcionalidades no fue aportado; no se
reordena ni se sustituye. Publicación, CMS y medición siguen en etapas posteriores.
