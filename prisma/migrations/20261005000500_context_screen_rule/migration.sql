-- =====================================================================
-- Manual migration 6 — context variables belong to their origin screen (CP-07)
-- Created with: npx prisma migrate dev --create-only --name context_screen_rule
-- (then this file was written by hand and versioned in Git)
-- Target: PostgreSQL 18.3 · Prisma ORM 7.10.0
--
-- Rule, for a variable with scope = CONTEXT and origin screen S:
--   * variable_collection row with screen_id <> S           -> rejected (UpdateContext elsewhere)
--   * screen_variable row with screen_id <> S and
--     access_mode READ or READ_WRITE                         -> rejected
--     (WRITE is allowed: Navigate can set the context variable of the target screen)
--   * origin_screen_id IS NULL -> any screen_variable / variable_collection row -> rejected
--   * changing variable.scope or variable.origin_screen_id re-checks all its rows
--   * GLOBAL variables are never checked
--
-- Constraint triggers DEFERRABLE INITIALLY DEFERRED: one PUT /variables can change
-- scope and origin together, and ensure_origin_write_link() moves the 'origin' row
-- inside the same transaction; only the state at COMMIT is judged.
--
-- Exception: when the origin becomes NULL because the origin screen was deleted
-- (ON DELETE SET NULL), the check on `variable` is skipped, so the screen can be
-- deleted and the variable is left without traceability. New links to it are still
-- rejected. Detected as: origin went from S to NULL and screen S no longer exists.
-- (pg_trigger_depth() cannot be used: AFTER triggers queued by the RI cascade run
--  at depth 1, the same as a direct UPDATE — verified on PostgreSQL 18.3.)
--
-- Error contract for the API (errorHandler -> 422 CONTEXT_SCREEN_MISMATCH):
--   SQLSTATE 23514 (check_violation), CONSTRAINT = 'context_screen_mismatch',
--   MESSAGE starts with 'CONTEXT_SCREEN_MISMATCH', DETAIL = JSON with
--   variableId, variableName, originScreenId, screenId, table, rowId.
-- =====================================================================

CREATE FUNCTION check_context_screen_links() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id     int;
  v_name   text;
  v_scope  variable_scope;
  v_origin int;
  bad      record;
BEGIN
  IF TG_TABLE_NAME = 'variable' THEN
    v_id := NEW.id;
    -- Origin cleared by the ON DELETE SET NULL of a deleted screen: allowed.
    IF OLD.origin_screen_id IS NOT NULL AND NEW.origin_screen_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM screen WHERE id = OLD.origin_screen_id) THEN
      RETURN NULL;
    END IF;
  ELSE
    v_id := NEW.variable_id;
  END IF;

  -- Deferred: judge the CURRENT state, not the row image of the queued event.
  SELECT name, scope, origin_screen_id INTO v_name, v_scope, v_origin
    FROM variable WHERE id = v_id;
  IF NOT FOUND OR v_scope <> 'CONTEXT' THEN
    RETURN NULL;                                  -- deleted meanwhile, or GLOBAL
  END IF;

  -- Rows to judge: the one that fired (link tables) or all of the variable's rows.
  SELECT x.tbl, x.row_id, x.screen_id INTO bad
    FROM (
      SELECT 'screen_variable'::text AS tbl, sv.id AS row_id, sv.screen_id
        FROM screen_variable sv
       WHERE sv.variable_id = v_id
         AND (TG_TABLE_NAME = 'variable' OR (TG_TABLE_NAME = 'screen_variable' AND sv.id = NEW.id))
         AND (v_origin IS NULL
              OR (sv.screen_id <> v_origin AND sv.access_mode IN ('READ', 'READ_WRITE')))
      UNION ALL
      SELECT 'variable_collection', vc.id, vc.screen_id
        FROM variable_collection vc
       WHERE vc.variable_id = v_id
         AND (TG_TABLE_NAME = 'variable' OR (TG_TABLE_NAME = 'variable_collection' AND vc.id = NEW.id))
         AND (v_origin IS NULL OR vc.screen_id <> v_origin)
    ) AS x
   ORDER BY x.tbl, x.row_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'CONTEXT_SCREEN_MISMATCH: context variable % (%) can only be read or assigned in its origin screen (%); rejected % row % (screen %)',
                    v_name, v_id, COALESCE(v_origin::text, 'none'), bad.tbl, bad.row_id, bad.screen_id
      USING ERRCODE    = 'check_violation',
            CONSTRAINT = 'context_screen_mismatch',
            DETAIL     = json_build_object('variableId', v_id, 'variableName', v_name,
                                           'originScreenId', v_origin, 'screenId', bad.screen_id,
                                           'table', bad.tbl, 'rowId', bad.row_id)::text;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_screen_variable_context_screen
  AFTER INSERT OR UPDATE ON screen_variable
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_context_screen_links();

CREATE CONSTRAINT TRIGGER trg_variable_collection_context_screen
  AFTER INSERT OR UPDATE ON variable_collection
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_context_screen_links();

CREATE CONSTRAINT TRIGGER trg_variable_context_screen
  AFTER UPDATE OF scope, origin_screen_id ON variable
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_context_screen_links();

-- Not SECURITY DEFINER (it only reads tables the caller already writes);
-- PostgreSQL grants EXECUTE to PUBLIC by default: close that, as in migration 3.
REVOKE ALL ON FUNCTION check_context_screen_links() FROM PUBLIC;
