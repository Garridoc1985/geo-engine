# Goea Engine — instrucciones de desarrollo

Responder en español. Runtime objetivo: Ubuntu 24.04, Python 3.12 y PostgreSQL.
Leer README.md y docs/ARQ-01.md antes de modificar el núcleo.
Preservar fuentes, permisos y trazabilidad. No incorporar datos de clientes ni secretos.
No usar SQLite. No enviar evidencia interna a salidas públicas ni proveedores sin
control de acceso. Los módulos reference/ son antecedentes y no runtime productivo.
Las reglas del workspace de origen no se trasladan a este repositorio independiente.

Validación:
`GEO_TEST_DATABASE_URL=postgresql:///geo_engine .venv/bin/python -m unittest discover -s tests -v`

No marcar el sprint completo hasta demostrar recuperación autorizada, suficiencia
y dos borradores con fuentes. Publicación web/CMS y medición siguen fuera del sprint.
