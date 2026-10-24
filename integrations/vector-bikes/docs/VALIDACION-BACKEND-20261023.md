# Validación del backend — 23 de octubre de 2026

Alcance autorizado: código, pruebas unitarias e integración, compilación, pruebas
del build y smoke HTTP local. Tablet excluida por el responsable. El despliegue
se mantiene en vista previa; no se fusiona `main` ni se activa producción.

## Correcciones

- Restaurado `.replit` desde la fuente original: faltaba en la importación y la
  suite de configuración no podía cargarlo. No se modificaron sus aserciones.
- `dashboard-finance.test.ts` cierra su instancia PGlite después de cada caso.
  La revisión confirmó que faltaba ese cierre en las tres pruebas de la suite.
- La base de desarrollo `vector_geo_validation_e2e` estaba vacía. Se aplicaron
  las migraciones existentes únicamente en esa base local; luego se verificaron
  las 27 tablas, las columnas del esquema y la restricción de estados.

## Evidencia

- `pnpm format`: aprobado, con dos advertencias CSS preexistentes.
- `pnpm check`: aprobado; Astro informa 0 errores, 0 warnings y 61 hints.
- Build del backend: aprobado; tests del build: 4 archivos y 37 casos aprobados.
- Primera ejecución completa: 67 archivos; 64 aprobados, una suite sin `.replit`
  y dos timeouts durante preparación. 908 casos aprobados y 2 fallidos por timeout.
- Reejecución de las tres suites afectadas: 3 archivos y 67 casos aprobados.
  Junto con las 64 suites ya aprobadas, quedan cubiertas las 67 suites y los
  915 casos distintos (incluidos los 5 que antes no cargaban por faltar `.replit`).
  Este resultado combina la ejecución completa y la reejecución dirigida;
  no se presenta la primera ejecución como aprobada.
- `db:check`: aprobado sobre la base local migrada.
- `scripts/smoke.sh`: aprobado (`ok: true`, `db: true`); comprueba disponibilidad,
  páginas, redirección de administración y rechazo de solicitudes no autenticadas
  a recordatorios y fotos. No envía correos ni crea reservas.

Las pruebas se ejecutaron con Node 24.13.1, Vitest 5.0.1, `--pool=forks` y un
máximo de dos procesos. La reejecución usa un proceso. No se alteraron `gate`,
los tiempos límite, las aserciones ni los casos internos de concurrencia.
El fatal V8 anterior no volvió a aparecer en esta ejecución; eso no demuestra
una corrección del runtime. Los tests con PGlite tampoco sustituyen todas las
condiciones de concurrencia entre conexiones reales de PostgreSQL.

La disponibilidad inicial fallaba por dos condiciones del entorno: PostgreSQL
de WSL no era alcanzable desde Windows y la base no tenía tablas. Se confirmó
la conexión local antes de aplicar las migraciones y repetir el smoke.

`gate` incluye tablet, por lo que no se declara una ejecución literal de ese
comando. Se registran sus componentes autorizados, sin cambiar el comando.
