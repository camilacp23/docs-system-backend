# 04_api: contrato de la API REST

- `openapi.yaml`: **OpenAPI 3.1, versión 0.3.1, 50 operaciones** (las 41 de la Tabla 25 del SRS, 4 de aplicaciones, 4 de reportes guardados y el webhook de Jira). Cada operación declara `x-capability` (fila de la Tabla 26), `x-roles` y, si aplica, `x-rule`. El backend genera la autorización y la validación de solicitudes a partir de este archivo.
- `check_contract_vs_db.py`: comprueba que los enums y los límites de longitud del contrato coincidan con la base migrada.

Cómo validarlo y usarlo: **`../00_LEEME.md`**, sección 6.
