"""Cross-check the OpenAPI contract against the migrated PostgreSQL database:
enum values and string length limits must match exactly.
Usage: python check_contract_vs_db.py <openapi.yaml> "<psql connection args>"
Example: python check_contract_vs_db.py openapi.yaml "-h localhost -U postgres -d docs_system"
Requires: pip install pyyaml ; psql in PATH. Exit code 1 if any difference."""
import sys, subprocess, shlex, yaml
spec_path, conn = sys.argv[1], sys.argv[2]
S = yaml.safe_load(open(spec_path))['components']['schemas']
def q(sql):
    r = subprocess.run(['psql', *shlex.split(conn), '-tA', '-F', '|', '-c', sql], capture_output=True, text=True, check=True)
    return [l.split('|') for l in r.stdout.strip().splitlines()]
db_enums = {t: v.split(',') for t, v in q("select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid=t.oid group by 1")}
lengths = {c: int(n) for c, n in q("select table_name||'.'||column_name, character_maximum_length from information_schema.columns where table_schema='public' and character_maximum_length is not null")}
ENUMS = {'UserRole': 'user_role', 'UserStatus': 'user_status', 'ApplicationStatus': 'application_status', 'Environment': 'environment',
         'VariableScope': 'variable_scope', 'AccessMode': 'access_mode', 'AssignmentFunction': 'assignment_function', 'DataType': 'data_type',
         'DocumentationStatus': 'documentation_status', 'ElementType': 'element_type', 'JiraHierarchyLevel': 'jira_hierarchy_level',
         'JiraStatusCategory': 'jira_status_category', 'ReportFormat': 'report_format', 'ReportStatus': 'report_status',
         'ReviewDecision': 'review_decision'}   # ReviewDecision: CP-11 (migration 20261005000400_review_decision)
LENGTHS = [('UserCreate', 'name', 'app_user.name'), ('UserCreate', 'email', 'app_user.email'), ('ApplicationWrite', 'name', 'application.name'),
           ('ApplicationWrite', 'platform', 'application.platform'), ('VariableWrite', 'name', 'variable.name'), ('CollectionWrite', 'name', 'collection.name'),
           ('CollectionFieldWrite', 'name', 'collection_field.name'), ('VariableAssignmentWrite', 'tableFunction', 'variable_collection.table_function'),
           ('UsedIn', None, 'variable_collection.used_in'), ('ReportRequest', 'title', 'report.title'),
           ('ReportCore', 'title', 'report.title'), ('ReportCore', 'fileName', 'report.file_name')]
ok = True
for api, db in ENUMS.items():
    same = S[api]['enum'] == db_enums[db]; ok &= same
    print('OK  ' if same else 'DIFF', api, '<->', db)
for sch, prop, col in LENGTHS:
    node = S[sch] if prop is None else S[sch]['properties'][prop]
    if '$ref' in node: node = S[node['$ref'].split('/')[-1]]
    same = node.get('maxLength') == lengths[col]; ok &= same
    print('OK  ' if same else 'DIFF', f'{sch}.{prop or ""} maxLength={node.get("maxLength")}', '<->', col, lengths[col])
print('ALL CONSISTENT' if ok else 'INCONSISTENCIES FOUND'); sys.exit(0 if ok else 1)
