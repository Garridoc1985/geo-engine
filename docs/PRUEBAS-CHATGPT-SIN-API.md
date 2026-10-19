# Validación del flujo con ChatGPT simulado

Registro de la etapa de construcción sin APIs de modelos: el 19 de octubre de
2026 pasaron 110 pruebas, incluidas las de integración con PostgreSQL. Después
de esa validación, el propietario autorizó comenzar con las APIs reales.
La nueva etapa se describe en [integración OpenAI](INTEGRACION-OPENAI.md).

## Recorrido que se prueba

```text
Consulta + empresa + tarea
    → pipeline GEO
    → conocimiento público de SCW en PostgreSQL
    → selección exclusiva del adaptador ChatGPT
    → respuesta HTTP simulada (sin conexión exterior)
    → extracción del texto de salida
    → borrador, fuentes y metadatos guardados en PostgreSQL
```

Las pruebas usan claves y modelos ficticios dentro de su entorno aislado. Se
sustituye el transporte HTTP, de modo que no se realiza ninguna solicitud al
servicio OpenAI. Claude y Perplexity no se construyen ni se usan en el modo
exclusivo, incluso si aparecen configurados en el entorno de pruebas.

Se cubren respuesta directa, perfil y preguntas frecuentes; ausencia de
configuración; errores temporales sin cambio de proveedor; exclusión de datos
internos; y coherencia entre resultado y registro PostgreSQL. Esto valida el
código del flujo, no la calidad de un modelo ni una conexión real a ChatGPT.

## Ejecutar en Ubuntu

```bash
GEO_TEST_DATABASE_URL=postgresql:///geo_engine .venv/bin/python -m unittest discover -s tests -q
```

La CLI incorpora selección explícita de proveedor para preparar pruebas aisladas:

```bash
.venv/bin/python -m geo_engine.cli geo "Prepara preguntas frecuentes" \
  --company demo_company --task faq --provider chatgpt
```

Este comando sólo planifica por defecto. Sin configuración devuelve `no_provider`
y conserva el contexto y la tarea seleccionados. La opción `--provider auto`
mantiene el orden general Claude → ChatGPT → Perplexity para usos posteriores.

Estas pruebas no usan `--execute` contra proveedores reales. La prueba de
integración sí ejercita la ruta de ejecución, pero con el transporte simulado.
