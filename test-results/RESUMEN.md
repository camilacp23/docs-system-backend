# Resultados de la verificación (12 oct 2026) · contrato 0.3.0 · CP-01 a CP-11

Ejecución limpia desde cero: sin roles ni bases previas, carpeta nueva, `npm install` y luego los pasos de `00_LEEME.md` en orden.

| Componente | Versión |
|---|---|
| Servidor PostgreSQL | **18.3** (`select version()` → `PostgreSQL 18.3 on x86_64-pc-linux-gnu`) |
| Node.js | 22.22.0 |
| Prisma ORM | 7.10.0 (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) |
| Redocly CLI | 2.11.1 |

Objetos de la base migrada (6 migraciones): **19 tablas, 16 enums, 64 índices, 34 CHECK, 51 triggers**. El enum nuevo es `review_decision`. Los triggers nuevos son los 3 de restricción de CP-07. No hay índices nuevos, así que `indexes_catalog.txt` no cambia.

| Paso / prueba | Archivo o comando | Resultado |
|---|---|---|
| 4.4 Migraciones | `prisma migrate deploy` | 6/6 aplicadas (`…_init` → `…_context_screen_rule`) |
| 4.6 Deriva | `npm run db:drift` | Ver la nota 1: sin diferencias estructurales |
| 01 Integridad del modelo | `tests/01_integrity_tests.sql` | **37/37 PASS** (27 anteriores + T27–T36) |
| 02 Auditoría y privilegios (rol docs_app) | `tests/02_audit_privilege_tests.sql` | **22/22 PASS** (21 + AU25) |
| 03 Solo inserción (rol docs_owner) | `tests/03_owner_immutability_tests.sql` | **3/3 PASS** |
| 04 Auditoría de punta a punta con Prisma | `npm run test:audit-e2e` | **11/11 PASS** |
| 05 Firma del webhook de Jira | `npm run test:jira-signature` | **9/9 PASS** |
| 06 Flujo de documentación | `npm run test:workflow` | **15/15 PASS** (13 + W14, W15) |
| 07 Autenticación, sesión y RBAC | `npm run test:auth` | **35/35 PASS** (29 + A30–A35). La matriz A23 sigue con **132 combinaciones** y la A25 con **50 operaciones** |
| 08 Validación de solicitudes contra el contrato | `npm run test:validation` | **14/14 PASS** (11 + V12–V14) |
| 09 Consulta del grafo de dependencias | `tests/09_dependency_graph_tests.sql` | **7/7 PASS** |
| 10 Comparación polimórfico vs. modelo adoptado | `tests/10_polymorphic_comparison.sql` | La tabla es igual a la de referencia: baseline `ACCEPTED`/huérfanos; adoptado `REJECTED`/0 huérfanos; A1 `SURVIVES` |
| **Total de verificaciones** | | **153/153 PASS** (131 + 22) |
| 6.1 Contrato OpenAPI 0.3.0 | `npx @redocly/cli@2.11.1 lint openapi.yaml --extends recommended` | **Válido, 0 errores y 0 advertencias** |
| 6.2 Contrato vs. base | `python check_contract_vs_db.py …` | **ALL CONSISTENT**, con 15 enums comparados (`ReviewDecision <-> review_decision` OK) y 9 longitudes |

**Nota 1. Deriva.** En este entorno la CLI de Prisma no puede descargar su motor nativo (403). Por eso la equivalencia se verificó de tres formas, sin la CLI:

1. La migración 5 es idéntica, línea por línea, al SQL que genera el motor de Prisma 7.10.0 entre el `schema.prisma` anterior y el nuevo, que es lo que escribe `prisma migrate dev`. Como control, el mismo método aplicado de un esquema vacío al `schema.prisma` anterior reproduce exactamente `…_init`.
2. Se comparó el catálogo de una base creada solo desde `schema.prisma` con el de la base migrada con las 6 migraciones: columnas, tipos, nulabilidad, valores por defecto, enums, PK/UK/FK e índices. Resultado: **0 diferencias en 304 filas**.
3. La migración 6 solo agrega una función y triggers, que Prisma no modela.

**En tu máquina, `npm run db:drift` con la CLI real debe decir `No difference detected`** (guía de cambios, paso C6). Si lo dice, anota ese resultado aquí.

**Nota 2. Mensajes.** Los `.txt` muestran los mensajes de PostgreSQL en inglés. En una instalación configurada en español aparecen traducidos, y el resultado es el mismo. Los mensajes propios del sistema (`CONTEXT_SCREEN_MISMATCH: …` y los de la API) están siempre en inglés. En PostgreSQL 18, el texto del caso A2 de la prueba 10 cambió de redacción («violates RESTRICT setting of foreign key constraint»), pero el resultado sigue siendo `REJECTED`.

**Nota 3.** En este entorno, el cliente `psql` es 16.15 y el servidor es 18.3. Las pruebas dependen solo del servidor.
