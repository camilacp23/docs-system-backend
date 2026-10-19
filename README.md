# docs-system-backend

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
| `docs/design/` | SDD v1.0 (cómo se construye) |
| `docs/phase3/` | Decisiones posteriores al SDD (`DECISIONS_FASE3.md`) y plan semanal (`PLAN_SEMANA6.md`) |
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

Verificación del contrato:

```bash
npx @redocly/cli@2.11.1 lint api/openapi.yaml --extends recommended
python api/check_contract_vs_db.py api/openapi.yaml "-h localhost -U postgres -d docs_system"
```
