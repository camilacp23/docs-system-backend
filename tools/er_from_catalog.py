"""Build the physical ER figure (Graphviz) from the live PostgreSQL catalog.
Usage: python3 tools/er_from_catalog.py <dbname> <out.png> [--keys-only]"""
import subprocess, sys, collections
db, out = sys.argv[1], sys.argv[2]
keys_only = '--keys-only' in sys.argv
def q(sql):
    r = subprocess.run(['su', 'postgres', '-c', f'psql -d {db} -tA -F"|" -c "{sql}"'], capture_output=True, text=True, check=True)
    return [l.split('|') for l in r.stdout.strip().splitlines() if l]
cols = q("select c.table_name, c.column_name, case when c.data_type='USER-DEFINED' then c.udt_name when c.data_type='ARRAY' then 'text[]' when c.data_type like 'timestamp%' then 'timestamptz' when c.data_type='character varying' then 'varchar('||c.character_maximum_length||')' when c.data_type='character' then 'char('||c.character_maximum_length||')' else c.data_type end, c.is_nullable from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema='public' and t.table_type='BASE TABLE' and c.table_name<>'_prisma_migrations' and c.column_name not in ('created_at','updated_at') order by c.table_name, c.ordinal_position")
pk = {(t, c) for t, c in q("select tc.table_name, k.column_name from information_schema.table_constraints tc join information_schema.key_column_usage k using (constraint_schema, constraint_name) where tc.table_schema='public' and tc.constraint_type='PRIMARY KEY'")}
fkrows = q("select con.conname, cl.relname, rf.relname, (select string_agg(a.attname, ',' order by u.ord) from unnest(con.conkey) with ordinality u(k, ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=u.k), con.confdeltype from pg_constraint con join pg_class cl on cl.oid=con.conrelid join pg_class rf on rf.oid=con.confrelid where con.contype='f' and con.connamespace='public'::regnamespace")
fkcols = {(t, c) for _, t, _, cs, _ in fkrows for c in cs.split(',')}
tables = collections.OrderedDict()
for t, c, ty, nul in cols:
    if keys_only and (t, c) not in pk and (t, c) not in fkcols:
        tables.setdefault(t, []); continue
    tables.setdefault(t, []).append((c, ty, nul))
groups = {'Identity and access': ['app_user', 'refresh_token'], 'Documented elements': ['application', 'documented_element', 'screen', 'variable', 'collection', 'component', 'collection_field', 'element_environment'],
          'Associative entities and dependency': ['screen_variable', 'screen_collection', 'variable_collection', 'dependency'], 'Jira, comments and reports': ['jira_ticket', 'comment', 'report', 'report_file'], 'Audit': ['audit_log']}
head = {'Identity and access': '#c6dcff', 'Documented elements': '#fff6b6', 'Associative entities and dependency': '#f8d3af', 'Jira, comments and reports': '#dedaff', 'Audit': '#e7e7e7'}
def node(t, color):
    rows = ''.join(f'<TR><TD ALIGN="LEFT" PORT="{c}"><FONT FACE="Helvetica">{"<B>" if (t,c) in pk else ""}{c}{"</B>" if (t,c) in pk else ""}</FONT></TD><TD ALIGN="LEFT"><FONT FACE="Helvetica" COLOR="#595959">{ty}{"" if nul=="YES" else " NN"}</FONT></TD><TD><FONT FACE="Helvetica" COLOR="#305bab">{" ".join(x for x,f in (("PK",(t,c) in pk),("FK",(t,c) in fkcols)) if f) or " "}</FONT></TD></TR>' for c, ty, nul in tables[t])
    return f'"{t}" [shape=plain label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="3" COLOR="#b0b0b0"><TR><TD COLSPAN="3" BGCOLOR="{color}"><FONT FACE="Helvetica-Bold">{t}</FONT></TD></TR>{rows}</TABLE>>];'
act = {'c': 'CASCADE', 'r': 'RESTRICT', 'n': 'SET NULL', 'a': 'NO ACTION'}
lines = ['digraph ER {', 'graph [rankdir=LR, splines=true, nodesep=0.4, ranksep=1.1, fontname="Helvetica", fontsize=11, pad=0.3, bgcolor="white"];', 'edge [color="#313131", arrowsize=0.6, fontname="Helvetica", fontsize=8, fontcolor="#595959"];']
for i, (g, ts) in enumerate(groups.items()):
    lines.append(f'subgraph cluster_{i} {{ label="{g}"; style="rounded"; color="#e7e7e7";')
    lines += [node(t, head[g]) for t in ts if t in tables]
    lines.append('}')
for name, t, rf, cs, d in fkrows:
    lines.append(f'"{t}":"{cs.split(",")[0]}" -> "{rf}" [tooltip="{cs} ({act.get(d, d)})"];')
lines.append('}')
open(out.replace('.png', '.dot'), 'w').write('\n'.join(lines))
subprocess.run(['dot', '-Tpng', '-Gdpi=170', '-o', out, out.replace('.png', '.dot')], check=True)
print('tables', len(tables), 'fks', len(fkrows), '->', out)
