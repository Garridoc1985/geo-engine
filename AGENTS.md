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

Directiva vigente del propietario: el producto busca visibilidad empresarial en
respuestas de IA (GEO), empezando por ChatGPT. No es una interfaz de preguntas
para el usuario ni un servicio de SEO tradicional o publicidad Google. El desarrollo
alimenta una capa backend que publica conocimiento autorizado en HTML, CMS o
servidor, con evolución y actualización controladas. No prometer indexación o citas.

Etapa actual: desarrollar publicación y descubrimiento. La generación real por
OpenAI y su persistencia ya se validaron manualmente con gpt-4.1-mini y gpt-6.1-sol;
esa conexión es auxiliar y no acredita descubrimiento ni posicionamiento externo.
El propietario autorizó usar DG Medios y Vector Bikes: solo su selección pública corroborada,
fuera del repositorio, sin trasladar notas internas de SCW. No guardar claves ni
sesiones de ChatGPT. La prioridad del router se conserva para generación auxiliar;
el primer canal de descubrimiento es ChatGPT. Pruebas automatizadas sin APIs reales.

Clasificación vigente por directiva del propietario: Perplexity es un buscador y
canal de descubrimiento futuro, no un proveedor de generación del router.
La prioridad auxiliar es Claude → ChatGPT → otras IA futuras. `origin=perplexity`
solo etiqueta el canal de origen y no selecciona proveedor ni activa búsquedas.
No hay conexión de búsqueda de Perplexity implementada.
