-- =====================================================================
-- Manual migration 2/4 — integrity rules not expressible in schema.prisma
-- Created with: npx prisma migrate dev --create-only --name integrity_rules
-- (then this file was written by hand and versioned in Git)
-- Contents: CHECK constraints · updated_at maintenance · integrity triggers
-- Target: PostgreSQL 16 · Prisma ORM 7.10.0
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CHECK constraints
-- ---------------------------------------------------------------------
ALTER TABLE app_user
  ADD CONSTRAINT app_user_email_lowercase_chk CHECK (email = lower(email)),
  ADD CONSTRAINT app_user_email_format_chk    CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT app_user_name_not_blank_chk  CHECK (btrim(name) <> '');

ALTER TABLE application
  ADD CONSTRAINT application_name_not_blank_chk  CHECK (btrim(name) <> ''),
  ADD CONSTRAINT application_jira_key_format_chk CHECK (jira_project_key IS NULL OR jira_project_key ~ '^[A-Z][A-Z0-9_]{1,19}$');

-- Subtypes: constant element_type makes the composite FK enforce type coherence
ALTER TABLE screen
  ADD CONSTRAINT screen_element_type_chk    CHECK (element_type = 'SCREEN'),
  ADD CONSTRAINT screen_name_not_blank_chk  CHECK (btrim(name) <> ''),
  ADD CONSTRAINT screen_miro_link_https_chk CHECK (miro_link IS NULL OR miro_link ~ '^https://');
ALTER TABLE variable
  ADD CONSTRAINT variable_element_type_chk   CHECK (element_type = 'VARIABLE'),
  ADD CONSTRAINT variable_name_not_blank_chk CHECK (btrim(name) <> '');
ALTER TABLE collection
  ADD CONSTRAINT collection_element_type_chk   CHECK (element_type = 'COLLECTION'),
  ADD CONSTRAINT collection_name_not_blank_chk CHECK (btrim(name) <> '');
ALTER TABLE component
  ADD CONSTRAINT component_element_type_chk   CHECK (element_type = 'COMPONENT'),
  ADD CONSTRAINT component_name_not_blank_chk CHECK (btrim(name) <> ''),
  ADD CONSTRAINT component_type_not_blank_chk CHECK (btrim(type) <> '');

ALTER TABLE collection_field
  ADD CONSTRAINT collection_field_position_chk       CHECK (position >= 0),
  ADD CONSTRAINT collection_field_name_not_blank_chk CHECK (btrim(name) <> '');

ALTER TABLE element_environment
  ADD CONSTRAINT element_environment_type_chk CHECK (element_type IN ('VARIABLE','COLLECTION'));

ALTER TABLE screen_variable
  ADD CONSTRAINT screen_variable_used_in_not_blank_chk CHECK (btrim(used_in) <> ''),
  ADD CONSTRAINT screen_variable_origin_is_write_chk   CHECK (used_in <> 'origin' OR access_mode = 'WRITE');
ALTER TABLE screen_collection
  ADD CONSTRAINT screen_collection_used_in_not_blank_chk CHECK (btrim(used_in) <> '');
ALTER TABLE variable_collection
  ADD CONSTRAINT variable_collection_used_in_not_blank_chk CHECK (btrim(used_in) <> ''),
  -- Set <-> global, UpdateContext <-> context (scope copied by the composite FK, ON UPDATE CASCADE)
  ADD CONSTRAINT variable_collection_function_scope_chk CHECK (
       (assignment_function = 'SET'            AND variable_scope = 'GLOBAL')
    OR (assignment_function = 'UPDATE_CONTEXT' AND variable_scope = 'CONTEXT'));

ALTER TABLE dependency
  ADD CONSTRAINT dependency_no_self_chk CHECK (source_id <> target_id),
  -- Only what the associative entities cannot express
  ADD CONSTRAINT dependency_allowed_pairs_chk CHECK (
       (source_type = 'COMPONENT'  AND target_type = 'VARIABLE'   AND relation_type = 'USES')
    OR (source_type = 'COMPONENT'  AND target_type = 'COLLECTION' AND relation_type = 'USES')
    OR (source_type = 'COLLECTION' AND target_type = 'COLLECTION' AND relation_type = 'DERIVES_FROM')
    OR (source_type = 'SCREEN'     AND target_type = 'SCREEN'     AND relation_type = 'NAVIGATES_TO'));

ALTER TABLE jira_ticket
  ADD CONSTRAINT jira_ticket_key_format_chk CHECK (jira_issue_key ~ '^[A-Z][A-Z0-9_]+-[0-9]+$'),
  -- Epic (one per screen) -> Story -> Subtask
  ADD CONSTRAINT jira_ticket_hierarchy_chk CHECK (
       (hierarchy_level = 'EPIC'     AND parent_ticket_id IS NULL     AND parent_level IS NULL)
    OR (hierarchy_level = 'STANDARD' AND parent_ticket_id IS NOT NULL AND parent_level = 'EPIC')
    OR (hierarchy_level = 'SUBTASK'  AND parent_ticket_id IS NOT NULL AND parent_level = 'STANDARD'));

ALTER TABLE comment
  ADD CONSTRAINT comment_text_not_blank_chk CHECK (btrim(text) <> '');

ALTER TABLE report
  ADD CONSTRAINT report_ready_has_file_chk  CHECK (status <> 'READY' OR (completed_at IS NOT NULL AND file_name IS NOT NULL)),
  ADD CONSTRAINT report_published_ready_chk CHECK (NOT is_published OR (status = 'READY' AND published_at IS NOT NULL));

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_action_chk     CHECK (action IN ('CREATE','UPDATE','DELETE','EVENT')),
  ADD CONSTRAINT audit_log_event_name_chk CHECK ((action = 'EVENT') = (event_name IS NOT NULL)),
  ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN (
    'app_user','application','screen','variable','collection','collection_field','component',
    'element_environment','screen_variable','screen_collection','variable_collection',
    'dependency','jira_ticket','comment','report'));

ALTER TABLE refresh_token
  ADD CONSTRAINT refresh_token_expiry_chk CHECK (expires_at > created_at);

-- ---------------------------------------------------------------------
-- 2. updated_at maintained by the database (Prisma's @updatedAt only
--    covers writes made through Prisma Client; this covers every path)
-- ---------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user','application','screen','variable','collection','collection_field',
                           'component','screen_variable','screen_collection','variable_collection',
                           'dependency','jira_ticket','comment','report'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3. Integrity triggers
-- ---------------------------------------------------------------------

-- 3.1 Deleting a subtype row deletes its supertype row (and, by cascade,
--     its dependencies). Cascades only travel referenced -> referencing.
CREATE FUNCTION delete_parent_element() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM documented_element WHERE id = OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_screen_delete_parent     AFTER DELETE ON screen     FOR EACH ROW EXECUTE FUNCTION delete_parent_element();
CREATE TRIGGER trg_variable_delete_parent   AFTER DELETE ON variable   FOR EACH ROW EXECUTE FUNCTION delete_parent_element();
CREATE TRIGGER trg_collection_delete_parent AFTER DELETE ON collection FOR EACH ROW EXECUTE FUNCTION delete_parent_element();
CREATE TRIGGER trg_component_delete_parent  AFTER DELETE ON component  FOR EACH ROW EXECUTE FUNCTION delete_parent_element();

-- 3.2 Every link stays inside one application. TG_ARGV = id columns to compare.
CREATE FUNCTION enforce_same_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_json jsonb := to_jsonb(NEW);
  ids      int[] := '{}';
  col      text;
  n_apps   int;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF row_json ->> col IS NOT NULL THEN
      ids := ids || (row_json ->> col)::int;
    END IF;
  END LOOP;
  SELECT count(DISTINCT application_id) INTO n_apps FROM documented_element WHERE id = ANY(ids);
  IF n_apps > 1 THEN
    RAISE EXCEPTION 'Cross-application link rejected on % (%)', TG_TABLE_NAME, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_screen_variable_same_app     BEFORE INSERT OR UPDATE ON screen_variable     FOR EACH ROW EXECUTE FUNCTION enforce_same_application('screen_id','variable_id');
CREATE TRIGGER trg_screen_collection_same_app   BEFORE INSERT OR UPDATE ON screen_collection   FOR EACH ROW EXECUTE FUNCTION enforce_same_application('screen_id','collection_id');
CREATE TRIGGER trg_variable_collection_same_app BEFORE INSERT OR UPDATE ON variable_collection FOR EACH ROW EXECUTE FUNCTION enforce_same_application('variable_id','collection_id','screen_id');
CREATE TRIGGER trg_dependency_same_app          BEFORE INSERT OR UPDATE ON dependency          FOR EACH ROW EXECUTE FUNCTION enforce_same_application('source_id','target_id');
CREATE TRIGGER trg_variable_origin_same_app     BEFORE INSERT OR UPDATE ON variable            FOR EACH ROW EXECUTE FUNCTION enforce_same_application('id','origin_screen_id');
CREATE TRIGGER trg_component_same_app           BEFORE INSERT OR UPDATE ON component           FOR EACH ROW EXECUTE FUNCTION enforce_same_application('id','screen_id');

-- 3.3 Origin screen <-> screen_variable 'origin' row (approved decision 3.5,
--     corrected: the previous origin row is removed when the origin changes)
CREATE FUNCTION ensure_origin_write_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.origin_screen_id IS NOT NULL
     AND OLD.origin_screen_id IS DISTINCT FROM NEW.origin_screen_id THEN
    DELETE FROM screen_variable
     WHERE screen_id = OLD.origin_screen_id AND variable_id = NEW.id AND used_in = 'origin';
  END IF;
  IF NEW.origin_screen_id IS NOT NULL THEN
    INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in)
    VALUES (NEW.origin_screen_id, NEW.id, 'WRITE', 'origin')
    ON CONFLICT (screen_id, variable_id, used_in) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_variable_origin_link
AFTER INSERT OR UPDATE OF origin_screen_id ON variable
FOR EACH ROW EXECUTE FUNCTION ensure_origin_write_link();

-- 3.4 App (OnStart) screen: created with each application; cannot be
--     deleted nor unflagged.
CREATE FUNCTION create_app_context_screen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_id int;
BEGIN
  INSERT INTO documented_element (type, application_id) VALUES ('SCREEN', NEW.id) RETURNING id INTO new_id;
  INSERT INTO screen (id, application_id, name, is_app_context, author_id)
  VALUES (new_id, NEW.id, 'App (OnStart)', true, NEW.created_by);
  RETURN NULL;
END $$;
CREATE TRIGGER trg_application_app_context AFTER INSERT ON application
FOR EACH ROW EXECUTE FUNCTION create_app_context_screen();

CREATE FUNCTION protect_app_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_app_context THEN
    RAISE EXCEPTION 'The App (OnStart) screen cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_app_context IS DISTINCT FROM NEW.is_app_context THEN
    RAISE EXCEPTION 'is_app_context cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_protect_app_context BEFORE DELETE OR UPDATE OF is_app_context ON screen
FOR EACH ROW EXECUTE FUNCTION protect_app_context();

-- 3.5 Every variable/collection exists in at least one environment (at COMMIT)
CREATE FUNCTION check_element_has_environment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid int;
BEGIN
  -- IF branches (not CASE): PL/pgSQL would resolve OLD.element_id on tables without that column
  IF TG_TABLE_NAME = 'element_environment' THEN eid := OLD.element_id; ELSE eid := NEW.id; END IF;
  IF EXISTS (SELECT 1 FROM documented_element WHERE id = eid AND type IN ('VARIABLE','COLLECTION'))
     AND NOT EXISTS (SELECT 1 FROM element_environment WHERE element_id = eid) THEN
    RAISE EXCEPTION 'Element % must exist in at least one environment (DEV/PROD)', eid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_variable_requires_env   AFTER INSERT ON variable
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_element_has_environment();
CREATE CONSTRAINT TRIGGER trg_collection_requires_env AFTER INSERT ON collection
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_element_has_environment();
CREATE CONSTRAINT TRIGGER trg_env_delete_keeps_one    AFTER DELETE OR UPDATE ON element_environment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_element_has_environment();

-- 3.6 Supertype completeness: every documented_element has its subtype (at COMMIT)
CREATE FUNCTION check_element_has_subtype() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documented_element WHERE id = NEW.id) THEN
    RETURN NULL;                              -- deleted in the same transaction
  END IF;
  found := CASE NEW.type
    WHEN 'SCREEN'     THEN EXISTS (SELECT 1 FROM screen     WHERE id = NEW.id)
    WHEN 'VARIABLE'   THEN EXISTS (SELECT 1 FROM variable   WHERE id = NEW.id)
    WHEN 'COLLECTION' THEN EXISTS (SELECT 1 FROM collection WHERE id = NEW.id)
    WHEN 'COMPONENT'  THEN EXISTS (SELECT 1 FROM component  WHERE id = NEW.id)
  END;
  IF NOT found THEN
    RAISE EXCEPTION 'documented_element % (%) has no % row', NEW.id, NEW.type, lower(NEW.type::text)
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_element_requires_subtype AFTER INSERT ON documented_element
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_element_has_subtype();
