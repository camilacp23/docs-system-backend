> Guía de la Fase 2. En este repositorio: 03_backend/ → raíz, 04_api/ → api/, 05_diagramas/ → docs/diagrams/.

# Guía: aplicar los cambios CP-01 a CP-11 y volver a ejecutar todas las pruebas

Proyecto: Sistema de Gestión de Documentación Técnica · Fase 2 (Diseño) · 12 oct 2026
Versiones: **PostgreSQL 18.3 · Node.js 22 · Prisma ORM 7.10.0** · Contrato **OpenAPI 0.3.0**

Esta guía parte de tu carpeta actual `C:\bitacora3`, donde ya ejecutaste la versión anterior (4 migraciones, 131 pruebas). Al terminar tendrás:

- la base recreada desde cero con **6 migraciones**;
- **153/153 verificaciones** en PASS;
- el contrato 0.3.0 validado.

Sigue los pasos **en orden** y en **una sola ventana de Git Bash**: las variables que definas en el paso B4 solo existen en esa ventana. Si la cierras, repite el paso B4.

---

## A. Qué cambió (resumen)

| Archivo | Cambio | CP |
|---|---|---|
| `03_backend/prisma/schema.prisma` | Enum `ReviewDecision` y columna `Comment.reviewDecision` (nulable) | CP-11 |
| `03_backend/prisma/migrations/20261005000400_review_decision/` | **Nueva, generada por Prisma**: crea el enum `review_decision` y la columna `comment.review_decision` | CP-11 |
| `03_backend/prisma/migrations/20261005000500_context_screen_rule/` | **Nueva, manual**: función `check_context_screen_links()` y 3 triggers diferidos | CP-07 |
| Las 4 migraciones anteriores | **Sin cambios** (no se editan nunca) | — |
| `04_api/openapi.yaml` | Versión 0.3.0, mensajes en inglés, catálogo de errores, 5 códigos 422 nuevos, `q` opcional, `topComponents`, `ReportDetailEnvelope`, `reviewDecision` | CP-01 a CP-11 |
| `04_api/check_contract_vs_db.py` | Compara 15 enums, incluido `review_decision` | CP-11 |
| `03_backend/.env.example` | Nueva variable obligatoria `INTEGRATION_USER_EMAIL` | CP-06 |
| `03_backend/src/security/*` | Mensajes en inglés; login rechaza la cuenta reservada; arnés de pruebas con la cuenta reservada y `SCREEN_IN_REVIEW` | CP-04, CP-06, CP-08 |
| `03_backend/src/modules/screens/documentationWorkflow.ts` | `assertEditable(status)` | CP-08 |
| `03_backend/tests/01, 02, 06, 07, 08` | 22 pruebas nuevas | todos |
| `03_backend/package.json` | Versiones exactas, sin `^` | — |
| `03_backend/.gitignore`, `TODO_FASE3.md` | Nuevos | — |

---

## B. Preparación (5 minutos)

### B1. Cierra pgAdmin (o cualquier programa conectado a PostgreSQL) y abre **Git Bash**.

### B2. Extrae el zip nuevo en una carpeta nueva
Extrae `entrega_cambios_CP01-CP11.zip` en **`C:\bitacora4`**, fuera de Descargas. La carpeta anterior `C:\bitacora3` queda como respaldo; no la borres todavía.
```bash
cd /c/bitacora4
ls
```
✅ Esperado: `00_LEEME.md  03_backend  04_api  05_diagramas  GUIA_CAMBIOS_CP01-CP11.md`

### B3. Reutiliza tu `.env` y agrega la variable nueva
```bash
cp /c/bitacora3/03_backend/.env /c/bitacora4/03_backend/.env
cd /c/bitacora4/03_backend
echo 'INTEGRATION_USER_EMAIL=integracion.jira@system.local' >> .env
grep -c INTEGRATION_USER_EMAIL .env
```
✅ Esperado: `1`. Si sale `2`, abre `.env` y deja una sola línea.

### B4. Variables de esta terminal
Sustituye las tres claves por las tuyas: la de `postgres` y las mismas de `docs_owner` y `docs_app` que ya están en tu `.env`. **Escríbelas entre comillas simples**, porque llevan `!`.
```bash
set +H
export PSQL_PAGER=cat
export PGPASSWORD='CLAVE_DE_POSTGRES'
OWN='CLAVE_OWNER_DEL_ENV'
APPPW='CLAVE_APP_DEL_ENV'
```
Comprueba que coinciden con `.env`:
```bash
grep -o "docs_owner:[^@]*" .env | head -1; echo "docs_owner:$OWN"
grep -o "docs_app:[^@]*" .env;            echo "docs_app:$APPPW"
```
✅ Esperado: cada par de líneas es idéntico.

> Tu zip anterior incluía `03_backend/.env` con contraseñas reales de tu máquina. **No compartas ese zip.** El paquete nuevo ya no trae `.env`, y `.gitignore` lo excluye. Si ese zip llegó a otra persona, usa contraseñas nuevas en B4 y en `.env` antes del paso C3.

---

## C. Base desde cero con las 6 migraciones

Todo se ejecuta desde `C:\bitacora4\03_backend` (`cd /c/bitacora4/03_backend`).

### C1. Instalar dependencias
```bash
npm install
```
✅ Esperado: `added ... packages` sin errores. La advertencia de `lodash.get` es inofensiva.

### C2. Borrar las bases y los roles anteriores
Primero mira qué se va a borrar:
```bash
psql -h localhost -U postgres -Atc "select datname from pg_database where datname in ('docs_system','docs_shadow') or datname ~ '^t[0-9]' or datname like 'prisma_migrate_shadow_db_%'"
```
✅ Esperado: `docs_system`, `docs_shadow` y las copias de prueba (`t01`, `t02`, …). **Si aparece alguna base tuya que no sea de este proyecto, detente y avísame.**

Después bórralas, junto con los dos roles:
```bash
for db in $(psql -h localhost -U postgres -Atc "select datname from pg_database where datname in ('docs_system','docs_shadow') or datname ~ '^t[0-9]' or datname like 'prisma_migrate_shadow_db_%'"); do dropdb -h localhost -U postgres "$db"; done
psql -h localhost -U postgres -c "DROP ROLE IF EXISTS docs_app;" -c "DROP ROLE IF EXISTS docs_owner;"
```
✅ Esperado: `DROP ROLE` dos veces. Si dice `cannot be dropped because some objects depend on it`, quedó alguna base: repite el primer comando de este paso y bórrala con `dropdb`.

### C3. Crear roles, base y base sombra
```bash
psql -h localhost -U postgres -v owner_pwd="$OWN" -v app_pwd="$APPPW" -v db_name=docs_system -f bootstrap/01_roles_and_database.sql
psql -h localhost -U postgres -c "ALTER ROLE docs_owner CREATEDB;"
psql -h localhost -U postgres -c "CREATE DATABASE docs_shadow OWNER docs_owner;"
```
✅ Esperado: `CREATE ROLE` (2), `CREATE DATABASE`, `REVOKE`, `GRANT`, `ALTER SCHEMA`, `REVOKE`, `ALTER ROLE` y `CREATE DATABASE`, sin `ERROR`.

### C4. Aplicar las migraciones
```bash
npx prisma migrate deploy
```
✅ Esperado: `6 migrations found in prisma/migrations` y `All migrations have been successfully applied`, en este orden:
```
20260928000000_init
20260928000100_integrity_rules
20260928000200_audit
20260928000300_privileges
20261005000400_review_decision      <- nueva (CP-11)
20261005000500_context_screen_rule  <- nueva (CP-07)
```

### C5. Generar el cliente de Prisma
```bash
npx prisma generate
```
✅ Esperado: `Generated Prisma Client (7.10.0) to ./src/generated/prisma`.

### C6. Verificación de deriva
```bash
npm run db:drift
```
✅ Esperado: **`No difference detected.`** Anótalo: es el dato de deriva de `RESUMEN.md` y del SDD 6.7.

### C7. Contar los objetos de la base (para el SDD)
```bash
psql -h localhost -U postgres -d docs_system -Atc "select 'tablas', count(*) from pg_tables where schemaname='public' and tablename<>'_prisma_migrations' union all select 'enums', count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and typtype='e' union all select 'indices', count(*) from pg_indexes where schemaname='public' and tablename<>'_prisma_migrations' union all select 'checks', count(*) from pg_constraint where connamespace='public'::regnamespace and contype='c' union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not tgisinternal"
```
✅ Esperado:
```
tablas|19
enums|16
indices|64
checks|34
triggers|51
```
Antes eran 15 enums y 48 triggers.

---

## D. Pruebas (en este orden)

Cada prueba que usa la base trabaja sobre una **copia nueva** de `docs_system` (`createdb -T`). **Nunca reutilices una copia**: si repites una prueba, bórrala primero con `dropdb -h localhost -U postgres tXX`.

Para contar los PASS sin leer toda la salida, agrega `2>&1 | grep -c "PASS "` al final del comando. Si Git Bash responde `stdout is not a tty`, escribe `psql.exe` en lugar de `psql`.

| # | Comandos | Esperado |
|---|---|---|
| 01 | `createdb -h localhost -U postgres -T docs_system t01`<br>`psql -h localhost -U postgres -d t01 -f tests/01_integrity_tests.sql` | **37** `PASS`, ninguna `FAIL`. Las nuevas son T27 a T36 |
| 02 | `createdb -h localhost -U postgres -T docs_system t02`<br>`PGPASSWORD="$APPPW" psql -h localhost -U docs_app -d t02 -f tests/02_audit_privilege_tests.sql` | **22** `PASS`. La nueva es AU25 |
| 03 | `PGPASSWORD="$OWN" psql -h localhost -U docs_owner -d t02 -f tests/03_owner_immutability_tests.sql` (misma copia `t02`) | **3** `PASS` |
| 04 | `createdb -h localhost -U postgres -T docs_system t04`<br>`APP_URL="postgresql://docs_app:$APPPW@localhost:5432/t04" ADMIN_URL="postgresql://postgres:$PGPASSWORD@localhost:5432/t04" npm run test:audit-e2e` | **11** `PASS` y `ALL PASSED` |
| 05 | `npm run test:jira-signature` | **9** `PASS` y `ALL PASSED` |
| 06 | `npm run test:workflow` | **15** `PASS` y `ALL PASSED`. Las nuevas son W14 y W15 |
| 07 | `createdb -h localhost -U postgres -T docs_system t07`<br>`APP_URL="postgresql://docs_app:$APPPW@localhost:5432/t07" OPENAPI=../04_api/openapi.yaml JWT_KEYS="k2026a:$(openssl rand -base64 32)" FRONTEND_ORIGIN=https://docs.local INTEGRATION_USER_EMAIL=integracion.jira@system.local npm run test:auth` | **35** `PASS` y `ALL PASSED` (≈1 min). Las nuevas son A30 a A35; A23 dice `(132 checks)` y A25 dice `(50 operations)` |
| 08 | `OPENAPI=../04_api/openapi.yaml npm run test:validation` | **14** `PASS`. Las nuevas son V12 a V14 |
| 09 | `createdb -h localhost -U postgres -T docs_system t09`<br>`psql -h localhost -U postgres -d t09 -f tests/09_dependency_graph_tests.sql` | **7** `PASS` |
| 10 | `createdb -h localhost -U postgres -T docs_system t10`<br>`psql -h localhost -U postgres -d t10 -f tests/10_polymorphic_comparison.sql` | La misma tabla que antes: *baseline* `ACCEPTED`/huérfanos; *adopted* `REJECTED`/0 huérfanos; A1 `SURVIVES` |

**Total: 37 + 22 + 3 + 11 + 9 + 15 + 35 + 14 + 7 = 153 PASS.**

Así se ven las pruebas nuevas de la 01 (tu PostgreSQL puede mostrar el texto en español, pero el código `CONTEXT_SCREEN_MISMATCH` siempre aparece en inglés):
```
PASS  T27 UpdateContext of a context variable from another screen -> rejected: CONTEXT_SCREEN_MISMATCH: ...
PASS  T30 WRITE link to a context variable from another screen (Navigate) -> accepted
PASS  T35 origin screen deleted: variable kept without origin, its WRITE link kept, new links rejected
PASS  T36 invalid review_decision value -> rejected: ... review_decision: "MAYBE"
```

**Si alguna prueba sale `FAIL`, no la cambies.** Copia la salida completa y envíamela.

### Limpieza
```bash
for db in t01 t02 t04 t07 t09 t10; do dropdb -h localhost -U postgres --if-exists $db; done
```

---

## E. Contrato de la API

```bash
cd /c/bitacora4/04_api
npx @redocly/cli@2.11.1 lint openapi.yaml --extends recommended
```
✅ Esperado: `Your API description is valid`, sin advertencias. La advertencia anterior de `info-license` ya no aparece.

```bash
python check_contract_vs_db.py openapi.yaml "-h localhost -U postgres -d docs_system"
```
✅ Esperado: 15 líneas de enums con `OK`, incluida `OK   ReviewDecision <-> review_decision`, 9 longitudes con `OK` y al final `ALL CONSISTENT`.

---

## F. Registrar tus resultados

Abre `03_backend/test-results/RESUMEN.md`. Trae los resultados de la ejecución de referencia, que son los mismos que debes obtener tú. Para dejar constancia de tu ejecución:

1. Cambia la primera línea a: `Ejecutados por la autora en la máquina de desarrollo (Windows · Git Bash), <fecha>`.
2. En la fila de Node.js, pon tu versión (`node --version`).
3. En la fila «4.6 Deriva», escribe `No difference detected` (paso C6) y borra la nota 1.

Datos para el SDD v1.0 (tablas 34, 40 y 69; secciones 6.3.6, 6.5.4, 6.7 y 11.5):

| Dato | Antes | Ahora |
|---|---|---|
| Migraciones | 4 | **6** (2 generadas, 4 manuales) |
| Tablas / enums / índices / CHECK / triggers | 19 / 15 / 64 / 34 / 48 | **19 / 16 / 64 / 34 / 51** |
| Verificaciones | 131 | **153** |
| Por archivo (01…09) | 27, 21, 3, 11, 9, 13, 29, 11, 7 | **37, 22, 3, 11, 9, 15, 35, 14, 7** |
| Contrato | 0.2.0, 50 operaciones | **0.3.0, 50 operaciones** |
| Matriz RBAC (A23) | 132 combinaciones | **132** (sin cambio) |

Cuando todo esté en PASS, puedes borrar `C:\bitacora3`.

---

## G. Problemas comunes

| Síntoma | Solución |
|---|---|
| `"more" no se reconoce como un comando` | Falta `export PSQL_PAGER=cat` (paso B4). |
| `bash: !...: event not found` | Falta `set +H`, o la clave no está entre comillas simples (paso B4). |
| `password authentication failed for user "docs_app"` | `$APPPW` no coincide con la clave usada en C3. Repite B4 con la misma clave. |
| `INTEGRATION_USER_EMAIL is required` | Falta la variable en el comando de la prueba 07 o en `.env` (paso B3). |
| `createdb: source database "docs_system" is being accessed by other users` | Cierra pgAdmin y repite. |
| `P1003 Database docs_shadow does not exist` en C6 | Falta el tercer comando de C3. |
| `migration ... was modified after it was applied` | Un editor cambió los finales de línea de una migración. Vuelve a extraer el zip y no abras las migraciones para editarlas. |
| La prueba 01 muestra `ya existe la función «expect_error»` | Reutilizaste una copia. Bórrala con `dropdb` y créala de nuevo con `createdb -T docs_system`. |
| La prueba 07 falla en A22 | La ejecutaste dos veces en menos de 15 min sobre la misma copia. Crea una copia nueva. |

---

## Anexo. Actualizar sin borrar (solo como referencia)

En un entorno con datos reales, la base **no** se recrea. Con las carpetas nuevas en su lugar y `INTEGRATION_USER_EMAIL` en `.env`, basta con:
```bash
npx prisma migrate deploy     # aplica solo las 2 pendientes: review_decision y context_screen_rule
npx prisma generate
npm run db:drift
```
Los triggers de la migración 6 verifican cada fila **que se inserta o modifica** a partir de ese momento, pero no revisan las filas que ya existían. Por eso, en un entorno con datos, antes de aplicarla se buscan los vínculos que ya violen CP-07. Debe devolver 0 filas; si devuelve alguna, se corrigen esos vínculos antes de seguir:
```sql
SELECT v.id, v.name, v.origin_screen_id, x.tbl, x.screen_id
FROM variable v
JOIN (SELECT 'screen_variable' AS tbl, variable_id, screen_id, access_mode::text AS mode FROM screen_variable
      UNION ALL
      SELECT 'variable_collection', variable_id, screen_id, 'ASSIGN' FROM variable_collection) x ON x.variable_id = v.id
WHERE v.scope = 'CONTEXT'
  AND (v.origin_screen_id IS NULL
       OR (x.screen_id <> v.origin_screen_id AND x.mode IN ('READ', 'READ_WRITE', 'ASSIGN')));
```
Si aparece un vínculo WRITE de una variable que quedó sin origen porque se borró su pantalla, es válido (es el caso de T35) y no hace falta corregirlo.

En tu base de desarrollo no hace falta, porque no tiene datos.
