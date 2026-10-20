# Validación del recorrido SCW a OpenAI

19 de octubre de 2026. Se añadió `tests/test_scw_openai_flow.py`.
No cambia la arquitectura ni los contratos existentes.

La prueba importa la empresa ficticia mediante la CLI, usa el cargador SCW,
recuperación y contexto públicos, el router, el adaptador HTTP de OpenAI y el
registro de borradores en PostgreSQL. Solo se sustituye el transporte HTTP;
la configuración de base se inyecta para usar un esquema aislado por prueba.
No consume APIs ni usa credenciales reales. Cada esquema se elimina al terminar.

Casos verificados:

- Borrador guardado y recuperado mediante `show-run`, con empresa y fuentes
  coincidentes con el contexto enviado. Solicitud Responses con `store=false`.
- Marcadores de contenido interno y retirado ausentes del contexto saliente.
- Un UUID ya reservado no provoca otra llamada al proveedor.
- Un error temporal se registra sin borrador ni reintento automático.
- Una empresa inexistente no recupera conocimiento de otra ni llama al proveedor.

Resultado: 128 pruebas aprobadas con PostgreSQL, sin omisiones. `git diff --check`
sin errores. La suite verifica el transporte simulado; no confirma una generación
real ni la calidad factual de una respuesta producida por un modelo externo.

La comprobación local de configuración no encontró `OPENAI_API_KEY` ni
`OPENAI_MODEL` en el proceso de desarrollo. El propietario indica que están
configurados en otra terminal. Ejecutar desde esa misma sesión:

```bash
cd ~/geo-engine
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt --check-access
```

Una respuesta `model_accessible` permite continuar con el procedimiento de
generación ficticia de `INTEGRACION-OPENAI.md`. No copiar claves al chat ni al
repositorio. La configuración mediante variables del proceso sigue las
[instrucciones oficiales de autenticación](https://developers.openai.com/api/reference/overview).
