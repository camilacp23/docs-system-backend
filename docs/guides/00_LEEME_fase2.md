# Entrega de la Bitácora 3 (26–28 sept 2026), actualizada con CP-01 a CP-11 (12 oct 2026): guía de uso y ejecución

Proyecto: Sistema de Gestión de Documentación Técnica · Fase 2 (Diseño)
Versiones verificadas: **PostgreSQL 18.3 · Node.js 22 · Prisma ORM 7.10.0** · Contrato **OpenAPI 0.3.0**

> ¿Ya tenías instalada la versión anterior (4 migraciones)? Sigue **`GUIA_CAMBIOS_CP01-CP11.md`**: explica paso a paso cómo pasar a esta versión.

---

## 1. Qué contiene la entrega

| Carpeta | Contenido | ¿Se ejecuta? |
|---|---|---|
| `01_SDD/` | El SDD en Word, en inglés (`_EN`) y en español (`_ES`). La versión vigente (v0.13 → v1.0) la mantiene la autora y no viaja en este paquete. | No; se abre en Word |
| `02_cambios_documentos/` | `cambios_SRS_v1.2.md`: qué cambiar en el SRS · `cambios_Bitacora_3.md`: cómo actualizar el texto de la bitácora | No; se lee |
| `03_backend/` | Proyecto ejecutable: modelo físico (`schema.prisma`), **6 migraciones**, creación de roles, código de seguridad de referencia, **10 archivos de prueba** (153 verificaciones) con sus resultados y `TODO_FASE3.md` | **Sí** (secciones 4 y 5) |
| `04_api/` | Contrato **OpenAPI 3.1** de las 50 operaciones y el script que lo compara con la base | **Sí** (sección 6) |
| `05_diagramas/` | Código fuente (Mermaid/Graphviz) e imágenes de las 12 figuras del SDD | Opcional (sección 7) |

---

## 2. Qué hacer primero (5 minutos, sin instalar nada)

1. Abre el SDD en español en Word.
2. Word preguntará si deseas **actualizar los campos**: responde **Sí**. Así se genera el índice. Si no pregunta: clic derecho sobre el índice → *Actualizar campos* → *Actualizar toda la tabla*.
3. Lee `02_cambios_documentos/cambios_SRS_v1.2.md` y `02_cambios_documentos/cambios_Bitacora_3.md`.
4. Abre `03_backend/test-results/RESUMEN.md`: ahí están los resultados de todas las pruebas (153/153), ya ejecutadas en una carpeta limpia con PostgreSQL 18.3.

Lo que sigue (secciones 3 a 7) solo es necesario si quieres **reproducir** las pruebas en tu computadora.

---

## 3. Requisitos (instalar una sola vez)

| Software | Versión | Para qué | Comprobar con |
|---|---|---|---|
| PostgreSQL (servidor y `psql`) | 18 | Base de datos | `psql --version` |
| Node.js | 22 o superior | Prisma y pruebas | `node --version` |
| OpenSSL | cualquiera | Generar la llave JWT de prueba | `openssl version` |
| Python 3 + PyYAML | 3.10+ | Solo para el paso 6.2 | `python -c "import yaml"` (en Windows el comando es `python`; en Linux/macOS, `python3`) |

> **Windows:** ejecuta los comandos en **Git Bash** o **WSL**; están escritos para una terminal tipo bash.

En todos los comandos, `postgres` es el superusuario de tu PostgreSQL. Si el tuyo se llama distinto, cámbialo. Donde dice `***`, escribe la contraseña real. Los comandos con `-U postgres` **pedirán la contraseña de `postgres`**: escríbela y presiona Enter (para no repetirla, puedes ejecutar antes `export PGPASSWORD=...` en esa terminal).

**Tiempo estimado** para reproducir todo (secciones 4 a 6): unos 15 minutos, la mayor parte en `npm install` y en la prueba 07.

---

## 4. Preparar la base de datos (hacerlo en este orden)

Todos los comandos se ejecutan **dentro de la carpeta `03_backend`**:

```bash
cd 03_backend
```

### Paso 4.1 · Instalar las dependencias
```bash
npm install
```
✅ Esperado: termina sin errores y crea la carpeta `node_modules/`.

### Paso 4.2 · Crear los roles y la base (solo la primera vez)
Crea dos roles: `docs_owner`, dueño del esquema, y `docs_app`, que es el que usa la API. También crea la base `docs_system`. Elige dos contraseñas y anótalas:
```bash
psql -h localhost -U postgres -v owner_pwd='CLAVE_OWNER' -v app_pwd='CLAVE_APP' -v db_name=docs_system -f bootstrap/01_roles_and_database.sql
```
✅ Esperado: sin mensajes de error.
Opcional, solo en desarrollo (lo necesita el paso 4.6): permiso para bases auxiliares y la **base sombra** `docs_shadow`, que Prisma usa para comparar. Prisma no la crea cuando se indica en `SHADOW_DATABASE_URL`, y la vacía en cada uso, así que no guardes nada en ella:
```bash
psql -h localhost -U postgres -c "ALTER ROLE docs_owner CREATEDB;"
psql -h localhost -U postgres -c "CREATE DATABASE docs_shadow OWNER docs_owner;"
```

### Paso 4.3 · Configurar el archivo `.env`
```bash
cp .env.example .env
```
Abre `.env` y reemplaza `CHANGE_ME` en `DATABASE_URL` y `SHADOW_DATABASE_URL` (contraseña de `docs_owner`) y en `APP_DATABASE_URL` (contraseña de `docs_app`). En `INTEGRATION_USER_EMAIL` escribe el correo de la cuenta reservada «Integración Jira», por ejemplo `integracion.jira@system.local` (CP-06): es obligatorio y la API no arranca sin él. Para este paso no hace falta llenar las demás variables de Jira. **Nunca subas `.env` a Git** (ya está en `.gitignore`).

### Paso 4.4 · Aplicar las 6 migraciones
```bash
npx prisma migrate deploy
```
✅ Esperado: `All migrations have been successfully applied`, con estas seis, en orden:
`20260928000000_init` → `20260928000100_integrity_rules` → `20260928000200_audit` → `20260928000300_privileges` → `20261005000400_review_decision` → `20261005000500_context_screen_rule`.

### Paso 4.5 · Generar el cliente de Prisma
```bash
npx prisma generate
```
✅ Esperado: `Generated Prisma Client (7.10.0) to ./src/generated/prisma`.

### Paso 4.6 · Verificación de deriva (drift)
Confirma que Prisma no intentará borrar los objetos creados a mano (CHECK, triggers, permisos). Requiere el `CREATEDB` del paso 4.2 y `SHADOW_DATABASE_URL` en `.env`:
```bash
npm run db:drift
```
✅ Esperado: `No difference detected` (código de salida 0). Si reporta diferencias, guarda la salida: es un hallazgo para el SDD (Sección 6.7).

---

## 5. Ejecutar las pruebas (en este orden)

**Regla importante:** las pruebas modifican datos, así que **nunca se ejecutan sobre `docs_system`**. Cada una usa una **copia desechable** creada a partir de ella con `createdb -T`. Para que la copia funcione, no debe haber nadie conectado a `docs_system` (cierra pgAdmin u otras sesiones).

Desde `03_backend/`:

| # | Qué verifica | Comandos | Esperado |
|---|---|---|---|
| 01 | Integridad del modelo (tipos, FK, reglas entre tablas, ambientes, Jira) | `createdb -h localhost -U postgres -T docs_system t01`<br>`psql -h localhost -U postgres -d t01 -f tests/01_integrity_tests.sql` | **37** líneas `PASS`, ninguna `FAIL` |
| 02 | Auditoría y permisos, **conectado como `docs_app`** (el rol real de la API) | `createdb -h localhost -U postgres -T docs_system t02`<br>`PGPASSWORD=CLAVE_APP psql -h localhost -U docs_app -d t02 -f tests/02_audit_privilege_tests.sql` | **22** `PASS` |
| 03 | `audit_log` no se puede modificar **ni siquiera por el dueño** (usa la misma copia `t02`) | `PGPASSWORD=CLAVE_OWNER psql -h localhost -U docs_owner -d t02 -f tests/03_owner_immutability_tests.sql` | 3 `PASS` |
| 04 | Auditoría de punta a punta con Prisma Client real | `createdb -h localhost -U postgres -T docs_system t04`<br>`APP_URL=postgresql://docs_app:CLAVE_APP@localhost:5432/t04 ADMIN_URL=postgresql://postgres:***@localhost:5432/t04 npm run test:audit-e2e` | 11 `PASS` y `ALL PASSED` |
| 05 | Firma HMAC del webhook de Jira (no usa la base) | `npm run test:jira-signature` | 9 `PASS` |
| 06 | Flujo de estados de la documentación (no usa la base) | `npm run test:workflow` | **15** `PASS` |
| 07 | Login, sesión de 12 h, refresh, permisos por rol (132 combinaciones) | `createdb -h localhost -U postgres -T docs_system t07`<br>`APP_URL=postgresql://docs_app:CLAVE_APP@localhost:5432/t07 OPENAPI=../04_api/openapi.yaml JWT_KEYS="k2026a:$(openssl rand -base64 32)" FRONTEND_ORIGIN=https://docs.local INTEGRATION_USER_EMAIL=integracion.jira@system.local npm run test:auth` | **35** `PASS` y `ALL PASSED` (tarda ≈1 min por bcrypt) |
| 08 | Validación de solicitudes contra el contrato (no usa la base) | `OPENAPI=../04_api/openapi.yaml npm run test:validation` | **14** `PASS` |
| 09 | Consulta del grafo de dependencias | `createdb -h localhost -U postgres -T docs_system t09`<br>`psql -h localhost -U postgres -d t09 -f tests/09_dependency_graph_tests.sql` | 7 `PASS` |
| 10 | Comparación del diseño polimórfico original con el adoptado | `createdb -h localhost -U postgres -T docs_system t10`<br>`psql -h localhost -U postgres -d t10 -f tests/10_polymorphic_comparison.sql` | Tabla: *baseline* `ACCEPTED`/huérfanos; *adopted* `REJECTED`/0 huérfanos; A1 `SURVIVES` |

Compara tu salida con `test-results/01.txt` … `10.txt`. **Total: 153 verificaciones** (37 + 22 + 3 + 11 + 9 + 15 + 35 + 14 + 7), más la tabla de la prueba 10.

### Limpieza al terminar
```bash
for db in t01 t02 t04 t07 t09 t10; do dropdb -h localhost -U postgres --if-exists $db; done
```

---

## 6. Verificar el contrato de la API (carpeta `04_api/`)

```bash
cd ../04_api
```
### Paso 6.1 · Validar el OpenAPI
```bash
npx @redocly/cli@2.11.1 lint openapi.yaml --extends recommended
```
✅ Esperado: `Your API description is valid`.

### Paso 6.2 · Comparar el contrato con la base
Comprueba que los enums y los límites de longitud de la API sean idénticos a los de PostgreSQL:
```bash
pip install pyyaml
python check_contract_vs_db.py openapi.yaml "-h localhost -U postgres -d docs_system"
```
✅ Esperado: 15 enums `OK` (incluido `ReviewDecision <-> review_decision`), 9 longitudes `OK` y la última línea `ALL CONSISTENT`.

### Paso 6.3 · (Opcional) Usarlo en Bruno
Bruno → *Import Collection* → *OpenAPI V3 Spec* → `openapi.yaml`. Se crea una carpeta por módulo.

---

## 7. (Opcional) Regenerar las imágenes de los diagramas

Solo si modificas un diagrama. Desde `05_diagramas/`:
```bash
npm i -g @mermaid-js/mermaid-cli
for f in 0*.mmd; do mmdc -i "$f" -o "${f%.mmd}.png" -s 3 -b white; done     # diagramas Mermaid
for f in 1*.dot; do dot -Tpng -Gdpi=200 -o "${f%.dot}.png" "$f"; done        # diagramas Graphviz
```
Si cambias un `.mmd`, pega el mismo código en el diagrama correspondiente de Miro: el SDD y Miro usan la misma fuente.

---

## 8. Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| `createdb: source database "docs_system" is being accessed by other users` | Hay una sesión abierta en `docs_system` (pgAdmin, DBeaver). Ciérrala y repite. |
| `password authentication failed for user "docs_app"` | La contraseña no coincide con la del paso 4.2. Cámbiala con `ALTER ROLE docs_app PASSWORD '...'` como `postgres`. |
| `npm run test:auth` falla en A22 | Se ejecutó dos veces en menos de 15 min con la misma copia: el límite de intentos sigue activo. Usa una copia nueva. |
| Aparece `"more" no se reconoce como un comando` (Windows) | Inofensivo: `psql` intenta usar un paginador que Git Bash no tiene. Los scripts ya lo desactivan; si aparece en otro comando, ejecuta `export PSQL_PAGER=cat`. |
| `bash: !...: event not found` (Git Bash) | La contraseña tiene `!`. Pon las URL entre comillas simples o ejecuta `set +H` una vez en la terminal. |
| `npm run db:drift` falla con `P1003 Database (not available) does not exist` | Falta la base sombra `docs_shadow`. Créala con el segundo comando opcional del paso 4.2. |
| `prisma migrate deploy` falla con `P3006` | Se editó una migración ya aplicada. No se editan: los cambios van en una migración nueva. |
| `INTEGRATION_USER_EMAIL is required` al ejecutar la prueba 07 o la API | Falta la variable o no es un correo. Agrégala a `.env` o al comando (paso 4.3). |
| `migration ... was modified after it was applied` | Un archivo de migración cambió sus finales de línea (CRLF). Vuelve a extraer el zip; no abras las migraciones con un editor que convierta los finales de línea. |
| No puedes ejecutar la CLI de Prisma (red bloqueada) | Usa `tools/migrate-wasm.mjs`. Es el sustituto con el que se verificó el diseño; la instrucción de instalación está en la primera línea del archivo. |

---

## 9. Reglas para la Fase 3 (desarrollo)

- **R-1:** toda llamada de Prisma dentro de una solicitud autenticada se hace con `await` dentro del contexto de auditoría.
- **R-2:** las escrituras de varios pasos o con SQL crudo van siempre dentro de `auditedTransaction()`.
- **R-3:** nunca se desactivan triggers; cualquier cambio a la auditoría va en una migración revisada.
- **R-4:** el frontend hace una sola renovación de sesión a la vez y la comparte entre pestañas.
- Una migración ya aplicada **no se edita**. Toda operación nueva de la API se declara primero en `openapi.yaml` con su `x-roles`; si no lo tiene, el servidor no arranca.
- Lo pendiente de CP-01 a CP-11 en los servicios está en `03_backend/TODO_FASE3.md`.
