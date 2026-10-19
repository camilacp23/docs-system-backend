# 03_backend: base ejecutable del backend

Para instalar y ejecutar, sigue **`../00_LEEME.md`** (secciones 4 y 5). Para actualizar una instalación que ya tenía las 4 migraciones, sigue **`../GUIA_CAMBIOS_CP01-CP11.md`**.

| Ruta | Contenido | Sección del SDD |
|---|---|---|
| `prisma/schema.prisma` | Modelo físico: 19 tablas, 16 enums, FK compuestas, índices | 6.2, 6.3, 6.6 |
| `prisma/migrations/` | 6 migraciones en orden: `init` (generada), `integrity_rules`, `audit`, `privileges` (manuales), `review_decision` (generada, CP-11) y `context_screen_rule` (manual, CP-07) | 6.3, 6.5, 6.7 |
| `bootstrap/01_roles_and_database.sql` | Roles `docs_owner` / `docs_app` y la base; lo ejecuta un DBA una sola vez | 6.7 |
| `src/db/prisma.ts` | Prisma Client con contexto de auditoría (`auditContext`, `auditedTransaction`) | 6.5 |
| `src/security/` | JWT, refresh token, bcrypt, middleware de autenticación y autorización generado desde el contrato | 11 |
| `src/integrations/jira/verifySignature.ts` | Verificación HMAC del webhook de Jira | 7.2.8 |
| `src/modules/screens/documentationWorkflow.ts` | Máquina de estados de la documentación | 9 |
| `src/modules/dependencies/graph.sql` | Consulta del grafo de dependencias | 10.1 |
| `tests/01…10` | Pruebas (SQL y TypeScript) | 6.3.6, 6.4.4, 6.5, 7, 9, 10, 11 |
| `test-results/` | Salida de la ejecución limpia en PostgreSQL 18.3; `RESUMEN.md` = 153/153 | — |
| `TODO_FASE3.md` | Lógica de servicios de CP-01 a CP-11 que se implementa en la Fase 3 | 7, 12 |
| `tools/migrate-wasm.mjs` | Sustituto de `prisma migrate deploy` solo si la CLI no puede descargar su motor | 6.7 |
| `indexes_catalog.txt` | Los 64 índices tal como existen en la base migrada | 6.6 |

`src/security/testApp.ts` es un **arnés de pruebas**, no la API final: monta las 50 operaciones con la cadena real de seguridad y respuestas simuladas para el negocio.
