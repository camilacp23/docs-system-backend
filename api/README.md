# 04_api: contrato de la API REST

- `openapi.yaml`: **OpenAPI 3.1, versión 0.4.0, 53 operaciones** (las 41 de la Tabla 25 del SRS, 4 de aplicaciones, 4 de reportes guardados, 3 del progreso del onboarding y el webhook de Jira). Cada operación declara `x-capability` (fila de la Tabla 26), `x-roles` y, si aplica, `x-rule`. El backend genera la autorización y la validación de solicitudes a partir de este archivo.
- `check_contract_vs_db.py`: comprueba que los enums y los límites de longitud del contrato coincidan con la base migrada.

## Cómo validarlo

Desde la raíz del repositorio, en este orden. La comparación con la base se hace siempre contra la base
desechable `docs_test_template` (migrada y al día), nunca contra `docs_system`:

```bash
npx @redocly/cli@2.11.1 lint api/openapi.yaml --extends recommended
npm run db:test:template
python api/check_contract_vs_db.py api/openapi.yaml "-h localhost -U postgres -d docs_test_template"
```

El script necesita `pyyaml` (`pip install pyyaml`) y `psql` en el PATH; la contraseña de `postgres` sale de
`pgpass.conf` (no uses `PGPASSWORD`). Termina con `ALL CONSISTENT` y código 0 si las enumeraciones y las longitudes
coinciden, o con `INCONSISTENCIES FOUND` y código 1.
