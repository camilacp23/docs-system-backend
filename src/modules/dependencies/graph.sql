-- =====================================================================
-- Dependency graph of one application (FR-15) — GET /dependencies/graph
-- Parameter $1 = application id. Returns { nodes: [...], edges: [...] }.
-- Nodes: the four kinds of documented element.
-- Edges: built by JOINING the associative entities, the origin column,
-- component.screen_id and `dependency` (approved decision §4): nothing is
-- stored twice. The 'origin' rows of screen_variable are excluded from
-- ACCESSES because the CREATES edge already represents them.
-- In the API: prisma.$queryRawUnsafe(sql, appId) or a TypedSQL query.
-- =====================================================================
WITH nodes AS (
  SELECT 'screen:' || s.id AS key, s.id, 'SCREEN' AS type, s.name, NULL::int AS screen_id,
         s.documentation_status::text AS documentation_status, s.is_app_context, NULL::text AS scope,
         NULL::boolean AS untraced, s.miro_link
    FROM screen s WHERE s.application_id = $1
  UNION ALL
  SELECT 'variable:' || v.id, v.id, 'VARIABLE', v.name, NULL, NULL, NULL, v.scope::text, v.origin_screen_id IS NULL, NULL
    FROM variable v WHERE v.application_id = $1
  UNION ALL
  SELECT 'collection:' || c.id, c.id, 'COLLECTION', c.name, NULL, NULL, NULL, NULL, NULL, NULL
    FROM collection c WHERE c.application_id = $1
  UNION ALL
  SELECT 'component:' || k.id, k.id, 'COMPONENT', k.name, k.screen_id, NULL, NULL, NULL, NULL, NULL
    FROM component k WHERE k.application_id = $1
),
edges AS (
  -- structure: screen contains component
  SELECT 'ct:' || k.id AS id, 'screen:' || k.screen_id AS source, 'component:' || k.id AS target, 'CONTAINS' AS kind,
         NULL::text AS access_mode, NULL::text AS used_in, NULL::text AS assignment_function, NULL::text AS table_function
    FROM component k WHERE k.application_id = $1
  UNION ALL
  -- origin: screen creates variable
  SELECT 'cr:' || v.id, 'screen:' || v.origin_screen_id, 'variable:' || v.id, 'CREATES', NULL, NULL, NULL, NULL
    FROM variable v WHERE v.application_id = $1 AND v.origin_screen_id IS NOT NULL
  UNION ALL
  -- associative entities
  SELECT 'sv:' || sv.id, 'screen:' || sv.screen_id, 'variable:' || sv.variable_id, 'ACCESSES', sv.access_mode::text, sv.used_in, NULL, NULL
    FROM screen_variable sv JOIN screen s ON s.id = sv.screen_id
   WHERE s.application_id = $1 AND sv.used_in <> 'origin'
  UNION ALL
  SELECT 'sc:' || sc.id, 'screen:' || sc.screen_id, 'collection:' || sc.collection_id, 'ACCESSES', sc.access_mode::text, sc.used_in, NULL, NULL
    FROM screen_collection sc JOIN screen s ON s.id = sc.screen_id
   WHERE s.application_id = $1
  UNION ALL
  SELECT 'vc:' || vc.id, 'collection:' || vc.collection_id, 'variable:' || vc.variable_id, 'FEEDS', NULL, vc.used_in,
         vc.assignment_function::text, vc.table_function
    FROM variable_collection vc JOIN variable v ON v.id = vc.variable_id
   WHERE v.application_id = $1
  UNION ALL
  -- what the associative entities cannot express
  SELECT 'd:' || d.id, lower(d.source_type::text) || ':' || d.source_id, lower(d.target_type::text) || ':' || d.target_id,
         d.relation_type::text, NULL, NULL, NULL, NULL
    FROM dependency d JOIN documented_element e ON e.id = d.source_id
   WHERE e.application_id = $1
)
SELECT json_build_object(
  'nodes', COALESCE((SELECT json_agg(n ORDER BY n.type, n.name) FROM nodes n), '[]'::json),
  'edges', COALESCE((SELECT json_agg(e ORDER BY e.id) FROM edges e), '[]'::json)) AS graph;
