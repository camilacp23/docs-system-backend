-- =====================================================================
-- Manual migration 3/4 — non-bypassable audit (approved decision 3.2)
-- Created with: npx prisma migrate dev --create-only --name audit
-- Mechanism: one generic AFTER INSERT/UPDATE/DELETE FOR EACH ROW trigger
-- function, SECURITY DEFINER with a fixed search_path, reading OLD/NEW.
-- The acting application user comes from the transaction-local setting
-- app.user_id, set by the backend with set_config(..., true).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Generic row-change audit function
--    TG_ARGV[0] = key column(s) of the row, comma-separated
--    TG_ARGV[1] = column used as human-readable label ('' = none)
--    TG_ARGV[2] = columns whose VALUES must never be stored (redacted),
--                 comma-separated; their NAMES still appear in changed_fields
-- ---------------------------------------------------------------------
CREATE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  key_cols   text[] := string_to_array(TG_ARGV[0], ',');
  label_col  text   := NULLIF(TG_ARGV[1], '');
  redacted   text[] := CASE WHEN TG_NARGS > 2 THEN string_to_array(TG_ARGV[2], ',') ELSE '{}'::text[] END;
  full_old   jsonb;
  full_new   jsonb;
  row_j      jsonb;
  changed    text[] := '{}';
  v_actor    int;
  v_app      int;
  v_setting  text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN full_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN full_new := to_jsonb(NEW); END IF;
  row_j := COALESCE(full_new, full_old);

  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(array_agg(n.key ORDER BY n.key), '{}') INTO changed
      FROM jsonb_each(full_new) AS n
     WHERE n.key <> 'updated_at'
       AND n.value IS DISTINCT FROM full_old -> n.key;
    IF cardinality(changed) = 0 THEN
      RETURN NULL;                               -- no-op update: nothing to record
    END IF;
  END IF;

  -- Acting application user (NULL when the write did not come through the API)
  v_setting := current_setting('app.user_id', true);
  IF v_setting ~ '^[0-9]+$' THEN v_actor := v_setting::int; END IF;

  -- Application of the row (best effort; loose reference, no FK)
  IF TG_TABLE_NAME = 'application' THEN
    v_app := (row_j ->> 'id')::int;
  ELSIF row_j ? 'application_id' THEN
    v_app := (row_j ->> 'application_id')::int;
  ELSE
    SELECT e.application_id INTO v_app
      FROM documented_element e
     WHERE e.id = COALESCE((row_j ->> 'screen_id')::int, (row_j ->> 'element_id')::int,
                           (row_j ->> 'source_id')::int, (row_j ->> 'collection_id')::int,
                           (row_j ->> 'variable_id')::int);
  END IF;

  INSERT INTO audit_log (actor_user_id, db_role, action, entity_type, entity_id, entity_label,
                         application_id, old_value, new_value, changed_fields)
  VALUES (
    v_actor,
    session_user,
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END,
    TG_TABLE_NAME,
    array_to_string(ARRAY(SELECT row_j ->> c FROM unnest(key_cols) AS c), ':'),
    left(row_j ->> label_col, 300),
    v_app,
    full_old - redacted,
    full_new - redacted,
    changed
  );
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 2. Triggers on every documented table (incl. associative entities and
--    dependency). Not audited, on purpose:
--      documented_element  (its data is repeated in the subtype's record)
--      report_file         (binary; the report row is audited)
--      refresh_token       (security material; logins are business events)
--      audit_log           (the log itself)
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('app_user',            'id',                     'name',           'password_hash'),
      ('application',         'id',                     'name',           NULL),
      ('screen',              'id',                     'name',           NULL),
      ('variable',            'id',                     'name',           NULL),
      ('collection',          'id',                     'name',           NULL),
      ('collection_field',    'id',                     'name',           NULL),
      ('component',           'id',                     'name',           NULL),
      ('element_environment', 'element_id,environment', 'environment',    NULL),
      ('screen_variable',     'id',                     'used_in',        NULL),
      ('screen_collection',   'id',                     'used_in',        NULL),
      ('variable_collection', 'id',                     'used_in',        NULL),
      ('dependency',          'id',                     'relation_type',  NULL),
      ('jira_ticket',         'id',                     'jira_issue_key', NULL),
      ('comment',             'id',                     'text',           NULL),
      ('report',              'id',                     'title',          NULL)
    ) AS t(tbl, keys, label, redact)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L, %3$L%4$s)',
      r.tbl, r.keys, r.label, CASE WHEN r.redact IS NULL THEN '' ELSE format(', %L', r.redact) END);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3. Business events that are not row writes (e.g. DOCUMENTATION_APPROVED).
--    The API role has no INSERT on audit_log; this is its only entry point.
-- ---------------------------------------------------------------------
CREATE FUNCTION log_business_event(
  p_event_name     text,
  p_entity_type    text,
  p_entity_id      text,
  p_entity_label   text  DEFAULT NULL,
  p_payload        jsonb DEFAULT NULL,
  p_application_id int   DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_setting text := current_setting('app.user_id', true);
  v_id      bigint;
BEGIN
  IF p_event_name !~ '^[A-Z][A-Z0-9_]{2,99}$' THEN
    RAISE EXCEPTION 'Invalid event name: %', p_event_name USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_setting IS NULL OR v_setting !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Business events require app.user_id in the current transaction'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_log (actor_user_id, db_role, action, event_name, entity_type, entity_id,
                         entity_label, application_id, new_value)
  VALUES (v_setting::int, session_user, 'EVENT', p_event_name, p_entity_type, p_entity_id,
          left(p_entity_label, 300), p_application_id, p_payload)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------
-- 4. Append-only: no UPDATE, DELETE or TRUNCATE on audit_log for ANY role,
--    the owner included. Removing this protection requires dropping the
--    trigger, which only the owner role can do, and only through a reviewed
--    migration versioned in Git. The API role cannot do it (not owner).
-- ---------------------------------------------------------------------
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER trg_audit_log_immutable   BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

-- Functions are executable by PUBLIC by default in PostgreSQL: close that.
REVOKE ALL ON FUNCTION audit_row_change()      FROM PUBLIC;
REVOKE ALL ON FUNCTION forbid_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION log_business_event(text, text, text, text, jsonb, int) FROM PUBLIC;
