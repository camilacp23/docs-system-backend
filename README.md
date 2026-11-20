# docs-system-backend

[![CI](https://github.com/camilacp23/docs-system-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/camilacp23/docs-system-backend/actions/workflows/ci.yml)

Backend de **Documentación técnica**, el sistema de gestión de documentación técnica del
Departamento de Arquitectura Empresarial (SAR es la primera aplicación documentada).
Fase 3 (desarrollo) sobre la base verificada en la Fase 2 (153 verificaciones).

Antes de cambiar nada, lee **[CLAUDE.md](CLAUDE.md)**: fuentes de verdad, pila exacta, reglas no
negociables, Git y definición de terminado. Toda la documentación está en **[docs/](docs/)**.

## Estructura

| Ruta | Contenido |
|---|---|
| `api/` | Contrato OpenAPI 3.1 (`openapi.yaml`, 50 operaciones) y `check_contract_vs_db.py`, que lo compara con la base |
| `bootstrap/` | `01_roles_and_database.sql`: roles `docs_owner` / `docs_app` y la base; lo ejecuta un DBA una sola vez |
| `docs/requirements/` | SRS v1.3 (qué debe hacer el sistema) |
| `docs/design/` | SDD v1.2 (cómo se construye) |
| `docs/phase3/` | Decisiones posteriores al SDD (`DECISIONS_FASE3.md`) y plan semanal (`PLAN_SEMANA6.md`) |
| `docs/phase4/TEST_PLAN.md` | [Plan de pruebas funcionales](docs/phase4/TEST_PLAN.md): alcance, niveles, entornos, criterios y severidad de defectos |
| `docs/phase4/TRACEABILITY_MATRIX.md` | [Matriz de trazabilidad](docs/phase4/TRACEABILITY_MATRIX.md): cada requisito (FR y NFR) con sus casos de prueba y su resultado |
| `docs/phase4/MANUAL_CASES.md` | [Casos manuales](docs/phase4/MANUAL_CASES.md): sandbox, producción, Jira Cloud y respaldo |
| `docs/phase4/DEFECTS.md` | [Registro de defectos](docs/phase4/DEFECTS.md) e incidentes del despliegue del 2026-11-19 |
| `docs/guides/` | Guías de la Fase 2: instalación y verificación de la base (`00_LEEME_fase2.md`, `GUIA_CAMBIOS_CP01-CP11.md`) |
| `docs/diagrams/` | Fuentes (Mermaid/Graphviz) e imágenes de las figuras del SDD |
| `prisma/` | `schema.prisma` (19 tablas, 16 enums) y `migrations/` (6 migraciones, inmutables) |
| `src/db/` | Prisma Client con contexto de auditoría (`auditContext`, `auditedTransaction`) |
| `src/security/` | JWT, refresh token, bcrypt, autenticación y autorización generada desde el contrato. `testApp.ts` es un arnés de pruebas, no la API final |
| `src/integrations/jira/` | Verificación HMAC del webhook de Jira |
| `src/modules/` | Lógica de negocio por módulo (hoy: máquina de estados de la documentación y consulta del grafo de dependencias) |
| `tests/` | Pruebas 01…10 de la Fase 2 (SQL y TypeScript), congeladas como regresión |
| `test-results/` | Salida de referencia de la Fase 2; `RESUMEN.md` = 153/153 |
| `tools/` | `migrate-wasm.mjs`, sustituto de `prisma migrate deploy` si la CLI no puede descargar su motor |
| `TODO_FASE3.md` | Lógica de servicios (CP-01 a CP-11) que se implementa en la Fase 3 |
| `indexes_catalog.txt` | Los 64 índices tal como existen en la base migrada |

## Comandos básicos

Requisitos: Node.js ≥ 22.22.0, PostgreSQL 18, `.env` creado a partir de `.env.example`
(nunca se versiona). Terminal tipo bash (Git Bash en Windows).

```bash
npm ci                      # instalar dependencias
npx prisma generate         # generar el cliente en src/generated/
npx prisma migrate status   # estado de las migraciones
npm run db:drift            # debe decir "No difference detected"
```

Las pruebas de la Fase 2 (`npm run test:*` y los SQL de `tests/`) se ejecutan sobre bases
desechables, nunca sobre `docs_system`: ver la sección 5 de
[docs/guides/00_LEEME_fase2.md](docs/guides/00_LEEME_fase2.md) (rutas nuevas: `OPENAPI=api/openapi.yaml`).

Verificación del contrato (la comparación con la base se hace contra la base desechable `docs_test_template`, nunca contra `docs_system`):

```bash
npx @redocly/cli@2.11.1 lint api/openapi.yaml --extends recommended
npm run db:test:template
python api/check_contract_vs_db.py api/openapi.yaml "-h localhost -U postgres -d docs_test_template"
```

### Prueba de rendimiento de la búsqueda

```bash
npm run test:perf
```

Corre solo `tests/perf/search.performance.test.ts`, sobre una base desechable (nunca `docs_system`). Carga una aplicación de unos
2000 elementos (500 pantallas con siete campos de plantilla de unos 5 KB cada una, 600 variables, 400 colecciones, 500
componentes y 800 vínculos, unos 17 MB de texto) y mide, con 7 lecturas de extremo a extremo, la mediana, el mínimo y el máximo
de cuatro búsquedas (texto común, texto sin resultados, solo filtros y una página alta). También imprime un resumen del plan de
PostgreSQL y compara contar el total en una sentencia aparte con `count(*) OVER ()`. No afirma ningún límite de tiempo: imprime
las cifras (líneas `PERF search ...`) y comprueba el tamaño de los datos, el contrato y que las respuestas tengan sentido.

Tarda unos 25 segundos. **No corre en `npm test` ni en el CI**: con tanto texto frena a las demás pruebas, y sus cifras dentro de
la suite en paralelo no son fiables. En `npm test` queda `tests/integration/search.scale.test.ts`, la misma consulta sobre unos
200 elementos, que verifica el resultado (totales contados con SQL aparte, páginas, orden estable) sin medir tiempos.

### Prueba de carga de los reportes

```bash
npm run test:perf:reports
```

Corre solo `tests/perf/reports.performance.test.ts` sobre una base desechable (nunca `docs_system`): carga una aplicación del tamaño
de un departamento (500 pantallas, 3000 componentes, 1000 variables, 300 colecciones con 10 campos y 1000 navegaciones), genera con
el worker real el reporte más grande (todas las partes y las dependencias) en PDF y en Excel, y también mide el costo de crear el
hilo de generación con un reporte diminuto. Imprime líneas `[perf]` con el tiempo, el tamaño del archivo, la memoria del proceso y
del hilo, y el retraso del event loop del hilo principal (p50, p99 y máximo). Se controla con variables de entorno de esta prueba
(no son las del servidor): `REPORT_PERF_TEXT` (`realistic` o `random`), `REPORT_PERF_FACTOR` (multiplica el tamaño), `REPORT_PERF_CHARS`
(caracteres de cada campo de la plantilla; 5000 por omisión), `REPORT_PERF_FORMAT` (`PDF` o `XLSX`) y los límites del worker
(`REPORT_MAX_SECONDS`, `REPORT_MAX_BYTES`, `REPORT_MAX_MEMORY_MB`, `REPORT_MAX_ROWS`), que la aplicación lee como en producción.
Por omisión usa texto realista (vocabulario que se repite); `random` genera palabras todas distintas, el peor caso para la caché de
diseño de pdfkit. **No corre en `npm test`.** Tarda de uno a tres minutos a escala completa; `npm run test:perf` también la incluye.
