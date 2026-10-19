# GEO Engine — instrucciones de desarrollo

Responder en español. Runtime objetivo: Ubuntu 24.04, Python 3.12 y PostgreSQL.
Leer README.md y docs/ARQ-01.md antes de modificar el núcleo.
Leer docs/PRODUCTO-Y-ARQUITECTURA.md: es la definición vigente y prevalece
sobre los alcances iniciales de ARQ-01 y los antecedentes de SCW.
Modo: desarrollo activo. implement_code=true, modify_architecture=true,
architecture_freeze=inactive. Se autoriza evolucionar contratos, API, esquema,
publicación y adaptadores para consumo por IA dentro de este repositorio.
Preservar fuentes, permisos y trazabilidad. No incorporar datos de clientes ni secretos.
No usar SQLite. No enviar evidencia interna a salidas públicas ni proveedores sin
control de acceso. Los módulos reference/ son antecedentes y no runtime productivo.
Las reglas del workspace de origen no se trasladan a este repositorio independiente.

Validación:
`GEO_TEST_DATABASE_URL=postgresql:///geo_engine .venv/bin/python -m unittest discover -s tests -v`

Registrar cambios de arquitectura y validar lo implementado. El plan inicial del
sprint es antecedente; el alcance puede evolucionar según la directiva vigente.
El producto entrega conocimiento a sistemas de IA; no requiere una interfaz de
consultas para usuarios. Publicación, descubrimiento y medición están habilitados
para desarrollo. Mantener controles de confidencialidad y autenticación.

Etapa actual: iniciar integración API real con OpenAI, por autorización del
propietario después de validar el flujo simulado. Comenzar solo con ChatGPT y
contenido público ficticio; conservar la prioridad general del router. No guardar
claves ni trasladar sesiones de ChatGPT al proyecto. Las pruebas automatizadas
siguen usando transporte simulado y no consumen APIs reales.
