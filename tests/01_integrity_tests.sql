-- Integrity test suite (run as a superuser on a DISPOSABLE copy of the migrated database)
-- Each test prints PASS/FAIL. "expect_error" tests must be rejected by the DB.
\pset pager off
\set QUIET on
SET client_min_messages = notice;

CREATE FUNCTION expect_error(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    SET CONSTRAINTS ALL IMMEDIATE;          -- fire deferred constraint triggers now
    RAISE NOTICE 'FAIL  % (statement was accepted)', label;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  % -> rejected: %', label, SQLERRM;
  END;
END $$;

-- The statement must be ACCEPTED, deferred constraint triggers included; its changes are kept.
CREATE FUNCTION expect_ok(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE NOTICE 'PASS  % -> accepted', label;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'FAIL  % (rejected: %)', label, SQLERRM;
  END;
END $$;

-- ---------- Fixtures ----------
INSERT INTO app_user (name, email, password_hash, role) VALUES ('Admin', 'admin@dept.local', 'x', 'ADMINISTRATOR');
INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'Power Apps', 1), ('OTRA', 'Power Apps', 1);

DO $$ BEGIN
  IF (SELECT count(*) FROM screen WHERE is_app_context) = 2 THEN
    RAISE NOTICE 'PASS  T01 App (OnStart) screen auto-created for each application';
  ELSE RAISE NOTICE 'FAIL  T01'; END IF;
END $$;

-- SAR elements: screen 'Inicio' (id 3), variable gUsuario (4), collection colClientes (5), component btnGuardar (6)
BEGIN;
INSERT INTO documented_element (type, application_id) VALUES ('SCREEN',1),('VARIABLE',1),('COLLECTION',1),('COMPONENT',1);
INSERT INTO screen (id, application_id, name, author_id) VALUES (3, 1, 'Inicio', 1);
INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id) VALUES (4, 1, 'gUsuario', 'RECORD', 'GLOBAL', 1);
INSERT INTO element_environment (element_id, element_type, environment) VALUES (4, 'VARIABLE', 'DEV'), (4, 'VARIABLE', 'PROD');
INSERT INTO collection (id, application_id, name) VALUES (5, 1, 'colClientes');
INSERT INTO element_environment (element_id, element_type, environment) VALUES (5, 'COLLECTION', 'DEV');
INSERT INTO component (id, application_id, screen_id, name, type) VALUES (6, 1, 3, 'btnGuardar', 'Button');
COMMIT;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM screen_variable WHERE screen_id = 1 AND variable_id = 4 AND used_in = 'origin' AND access_mode = 'WRITE') THEN
    RAISE NOTICE 'PASS  T02 origin trigger created screen_variable(App OnStart, gUsuario, WRITE, origin)';
  ELSE RAISE NOTICE 'FAIL  T02'; END IF;
END $$;

-- ---------- Type coherence (supertype / subtype) ----------
SELECT expect_error('T03 screen row pointing to a VARIABLE element',
  $q$INSERT INTO screen (id, application_id, name, author_id) VALUES (4, 1, 'Falsa', 1)$q$);
SELECT expect_error('T04 subtype with element_type different from its table',
  $q$INSERT INTO documented_element (id, type, application_id) VALUES (100,'VARIABLE',1);
     INSERT INTO screen (id, element_type, application_id, name, author_id) VALUES (100,'VARIABLE',1,'X',1)$q$);

-- ---------- Dependency rules ----------
SELECT expect_error('T05 dependency with a pair outside the allowed list (variable -> screen)',
  $q$INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (4,'VARIABLE',3,'SCREEN','USES')$q$);
SELECT expect_error('T06 dependency declaring a wrong type for an existing element',
  $q$INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (6,'SCREEN',3,'SCREEN','NAVIGATES_TO')$q$);
INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (6,'COMPONENT',4,'VARIABLE','USES');
DO $$ BEGIN RAISE NOTICE 'PASS  T07 valid dependency component -> variable accepted'; END $$;

-- ---------- Assignment function vs scope (T4) ----------
SELECT expect_error('T08 UpdateContext on a GLOBAL variable',
  $q$INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in)
     VALUES (4,'GLOBAL',5,3,'UPDATE_CONTEXT','btnFiltrar.OnSelect')$q$);
SELECT expect_error('T09 declaring a scope that is not the variable''s real scope',
  $q$INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in)
     VALUES (4,'CONTEXT',5,3,'UPDATE_CONTEXT','btnFiltrar.OnSelect')$q$);
INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, table_function, used_in)
VALUES (4,'GLOBAL',5,1,'SET','First','OnStart');
SELECT expect_error('T10 changing variable scope while a SET link exists (cascade + CHECK)',
  $q$UPDATE variable SET scope = 'CONTEXT' WHERE id = 4$q$);

-- ---------- Cross-application isolation ----------
BEGIN;
INSERT INTO documented_element (type, application_id) VALUES ('SCREEN',2);   -- id 7, app OTRA
INSERT INTO screen (id, application_id, name, author_id) VALUES (7, 2, 'Inicio', 1);   -- same name, other app: allowed
COMMIT;
DO $$ BEGIN RAISE NOTICE 'PASS  T11 same screen name allowed in a different application'; END $$;
SELECT expect_error('T12 linking a SAR variable to a screen of another application',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (7,4,'READ','OnVisible')$q$);

-- ---------- Environments ----------
SELECT expect_error('T13 variable without any environment (checked at commit)',
  $q$INSERT INTO documented_element (id, type, application_id) VALUES (200,'VARIABLE',1);
     INSERT INTO variable (id, application_id, name, data_type, scope) VALUES (200,1,'gSinAmbiente','TEXT','GLOBAL')$q$);
SELECT expect_error('T14 removing the last environment of a collection',
  $q$DELETE FROM element_environment WHERE element_id = 5$q$);

-- ---------- Names ----------
SELECT expect_error('T15 duplicate GLOBAL variable name in the same application',
  $q$INSERT INTO documented_element (id, type, application_id) VALUES (300,'VARIABLE',1);
     INSERT INTO variable (id, application_id, name, data_type, scope) VALUES (300,1,'gUsuario','TEXT','GLOBAL');
     INSERT INTO element_environment VALUES (300,'VARIABLE','DEV')$q$);

-- ---------- App (OnStart) protection ----------
SELECT expect_error('T16 deleting the App (OnStart) screen',
  $q$DELETE FROM documented_element WHERE id = 1$q$);

-- ---------- Origin change and cascades (T2, T3) ----------
UPDATE variable SET origin_screen_id = 3 WHERE id = 4;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM screen_variable WHERE screen_id = 1 AND variable_id = 4 AND used_in = 'origin')
     AND EXISTS (SELECT 1 FROM screen_variable WHERE screen_id = 3 AND variable_id = 4 AND used_in = 'origin') THEN
    RAISE NOTICE 'PASS  T17a origin moved: old origin row removed, new one created';
  ELSE RAISE NOTICE 'FAIL  T17a'; END IF;
END $$;
DELETE FROM documented_element WHERE id = 3;   -- delete screen 'Inicio' through its supertype
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM documented_element WHERE id = 6)          -- component's supertype gone
     AND NOT EXISTS (SELECT 1 FROM dependency WHERE source_id = 6)       -- its dependency gone
     AND (SELECT origin_screen_id FROM variable WHERE id = 4) IS NULL     -- SET NULL on origin
     AND EXISTS (SELECT 1 FROM variable WHERE id = 4) THEN
    RAISE NOTICE 'PASS  T17b screen delete: components + their supertype + dependencies removed, variable origin SET NULL';
  ELSE RAISE NOTICE 'FAIL  T17b'; END IF;
END $$;

-- ---------- Users ----------
SELECT expect_error('T18 physical delete of a user referenced as author',
  $q$DELETE FROM app_user WHERE id = 1$q$);
SELECT expect_error('T19 email stored with uppercase',
  $q$INSERT INTO app_user (name, email, password_hash, role) VALUES ('X','X@dept.local','x','READER')$q$);

-- ---------- Jira hierarchy (Epic per screen -> Story -> Subtask) ----------
BEGIN;
INSERT INTO documented_element (type, application_id) VALUES ('SCREEN',1);   -- id 8
INSERT INTO screen (id, application_id, name, author_id) VALUES (8, 1, 'Solicitudes', 1);
COMMIT;
INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, summary, status, status_category, created_by)
VALUES (8,'10001','TECHEA-1','EPIC','Epic','Pantalla Solicitudes','To Do','TO_DO',1);
INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, parent_level, summary, status, status_category, created_by)
VALUES (8,'10002','TECHEA-2','STANDARD','Story',1,'EPIC','Mejoras de la pantalla','To Do','TO_DO',1);
INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, parent_level, summary, status, status_category, created_by)
VALUES (8,'10003','TECHEA-3','SUBTASK','Subtask',2,'STANDARD','Validar correo','To Do','TO_DO',1);
DO $$ BEGIN RAISE NOTICE 'PASS  T20 valid chain Epic -> Story -> Subtask accepted'; END $$;
SELECT expect_error('T21 second Epic for the same screen',
  $q$INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, summary, status, status_category, created_by)
     VALUES (8,'10004','TECHEA-4','EPIC','Epic','Otra','To Do','TO_DO',1)$q$);
SELECT expect_error('T22 Subtask hanging directly from the Epic',
  $q$INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, parent_level, summary, status, status_category, created_by)
     VALUES (8,'10005','TECHEA-5','SUBTASK','Subtask',1,'STANDARD','X','To Do','TO_DO',1)$q$);
SELECT expect_error('T23 Subtask whose parent Story belongs to another screen',
  $q$INSERT INTO documented_element (id, type, application_id) VALUES (400,'SCREEN',1);
     INSERT INTO screen (id, application_id, name, author_id) VALUES (400,1,'Otra pantalla',1);
     INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, parent_level, summary, status, status_category, created_by)
     VALUES (400,'10006','TECHEA-6','SUBTASK','Subtask',2,'STANDARD','X','To Do','TO_DO',1)$q$);
SELECT expect_error('T24 Story without parent Epic',
  $q$INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, summary, status, status_category, created_by)
     VALUES (8,'10007','TECHEA-7','STANDARD','Story','X','To Do','TO_DO',1)$q$);

-- ---------- Supertype completeness (Activity 3) ----------
SELECT expect_error('T25 documented_element without its subtype row (checked at commit)',
  $q$INSERT INTO documented_element (id, type, application_id) VALUES (500,'COLLECTION',1)$q$);
SELECT expect_error('T26 changing the type of an element that already has its subtype',
  $q$UPDATE documented_element SET type = 'COLLECTION' WHERE id = 4$q$);

-- ---------- CP-07: context variables belong to their origin screen (migration 6) ----------
-- Fixtures (SAR): screens Detalle (601, origin) and Resumen (602); collection colPedidos (620);
--   locFiltro  (610) CONTEXT, origin 601, READ in 601
--   locMover   (613) CONTEXT, origin 601, READ in 601
--   locSinOrig (612) CONTEXT, no origin
--   gTotal     (611) GLOBAL,  origin 601
--   gModo      (614) GLOBAL,  origin 601, READ in 602
BEGIN;
INSERT INTO documented_element (id, type, application_id) VALUES
  (601,'SCREEN',1), (602,'SCREEN',1), (610,'VARIABLE',1), (611,'VARIABLE',1), (612,'VARIABLE',1),
  (613,'VARIABLE',1), (614,'VARIABLE',1), (620,'COLLECTION',1);
INSERT INTO screen (id, application_id, name, author_id) VALUES (601, 1, 'Detalle', 1), (602, 1, 'Resumen', 1);
INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id) VALUES
  (610, 1, 'locFiltro',  'TEXT',   'CONTEXT', 601),
  (611, 1, 'gTotal',     'NUMBER', 'GLOBAL',  601),
  (612, 1, 'locSinOrig', 'TEXT',   'CONTEXT', NULL),
  (613, 1, 'locMover',   'TEXT',   'CONTEXT', 601),
  (614, 1, 'gModo',      'TEXT',   'GLOBAL',  601);
INSERT INTO element_environment (element_id, element_type, environment) VALUES
  (610,'VARIABLE','DEV'), (611,'VARIABLE','DEV'), (612,'VARIABLE','DEV'), (613,'VARIABLE','DEV'),
  (614,'VARIABLE','DEV'), (620,'COLLECTION','DEV');
INSERT INTO collection (id, application_id, name) VALUES (620, 1, 'colPedidos');
INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES
  (601, 610, 'READ', 'lblFiltro.Text'), (601, 613, 'READ', 'galPedidos.Items'), (602, 614, 'READ', 'lblModo.Text');
COMMIT;

SELECT expect_error('T27 UpdateContext of a context variable from another screen',
  $q$INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, table_function, used_in)
     VALUES (610,'CONTEXT',620,602,'UPDATE_CONTEXT','First','btnFiltrar.OnSelect')$q$);
SELECT expect_error('T28 READ link to a context variable from another screen',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (602,610,'READ','lblFiltro.Text')$q$);
SELECT expect_error('T29 READ_WRITE link to a context variable from another screen',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (602,610,'READ_WRITE','txtFiltro.Default')$q$);
SELECT expect_ok('T30 WRITE link to a context variable from another screen (Navigate)',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (602,610,'WRITE','btnVerDetalle.OnSelect')$q$);
SELECT expect_error('T31 any link to a context variable without origin (even WRITE)',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (602,612,'WRITE','btnIr.OnSelect')$q$);
SELECT expect_error('T32 moving the origin so that an existing READ link becomes invalid',
  $q$UPDATE variable SET origin_screen_id = 602 WHERE id = 613$q$);
SELECT expect_error('T33 changing scope GLOBAL -> CONTEXT with READ links in other screens',
  $q$UPDATE variable SET scope = 'CONTEXT' WHERE id = 614$q$);
SELECT expect_ok('T34 the same operations on a global variable',
  $q$INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES
       (602,611,'READ','lblTotal.Text'), (602,611,'READ_WRITE','txtTotal.Default');
     INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, table_function, used_in)
       VALUES (611,'GLOBAL',620,602,'SET','CountRows','OnVisible');
     UPDATE variable SET origin_screen_id = 602 WHERE id = 611$q$);

-- T35 deleting the origin screen of a context variable with WRITE links in other screens
DELETE FROM documented_element WHERE id = 601;
DO $$
DECLARE new_link_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (602,610,'WRITE','btnOtra.OnSelect');
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN new_link_rejected := true;
  END;
  IF NOT EXISTS (SELECT 1 FROM screen WHERE id = 601)
     AND (SELECT origin_screen_id FROM variable WHERE id = 610) IS NULL
     AND EXISTS (SELECT 1 FROM screen_variable WHERE screen_id = 602 AND variable_id = 610 AND access_mode = 'WRITE')
     AND new_link_rejected THEN
    RAISE NOTICE 'PASS  T35 origin screen deleted: variable kept without origin, its WRITE link kept, new links rejected';
  ELSE RAISE NOTICE 'FAIL  T35 (new link rejected: %)', new_link_rejected; END IF;
END $$;

-- ---------- CP-11: review decision (migration 5) ----------
SELECT expect_error('T36 invalid review_decision value',
  $q$INSERT INTO comment (screen_id, user_id, text, review_decision) VALUES (8, 1, 'Approved.', 'MAYBE')$q$);
