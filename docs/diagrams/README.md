# 05_diagramas: figuras del SDD

Cada figura existe **una sola vez** como código fuente. El mismo código genera la imagen del Word y el diagrama editable en Miro (marcos "SDD Figure" del tablero del proyecto).

| Archivo | Tipo | Sección del SDD |
|---|---|---|
| `01_context` | Mermaid | 3 Contexto |
| `02_containers` | Mermaid | 4 Composición |
| `03_backend_layers` | Mermaid | 4.1 Backend por capas |
| `04_frontend` | Mermaid | 4.2 Frontend |
| `05_module_dependencies` | Mermaid | 5 Dependencias |
| `06_seq_jira_ticket` | Mermaid | 8.1 Creación de ticket en Jira |
| `07_seq_jira_webhook` | Mermaid | 8.2 Estado desde Jira |
| `08_seq_login_refresh` | Mermaid | 8.3 Sesión |
| `09_seq_report` | Mermaid | 8.4 Reportes asíncronos |
| `10_audit_flow` | Graphviz | 6.5 Auditoría |
| `11_er_physical` | Graphviz generado desde el catálogo de la base | 6.8 ER físico |
| `12_documentation_workflow` | Graphviz | 9 Flujo de documentación |

`11_er_physical` no tiene fuente fija: se genera desde la base migrada con `python3 er_from_catalog.py docs_system er_completo.png` (requiere Graphviz y acceso como `postgres`). El script produce la versión con todas las columnas; la figura del SDD muestra solo llaves primarias y foráneas. Para regenerar los demás, ver **`../00_LEEME.md`**, sección 7.
