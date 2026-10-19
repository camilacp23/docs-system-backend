-- =====================================================================
-- Bitácora 3 · Activity 3 — Referential-integrity validation
-- Same scenarios run against:
--   (1) BASELINE  : the polymorphic design left open by the SRS
--                   (type + id columns, no real FK)  -> schema "baseline"
--   (2) ADOPTED   : the migrated physical model       -> schema "public"
-- Run as a superuser on a DISPOSABLE copy of the migrated database (no other data):
--   psql -d <copy> -f tests/10_polymorphic_comparison.sql
-- =====================================================================
\pset pager off
\set QUIET on
SET client_min_messages = warning;
\pset tuples_only on

CREATE TEMP TABLE result (scenario text, design text, outcome text, detail text);

CREATE FUNCTION try_stmt(p_scenario text, p_design text, p_stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_stmt;
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO result VALUES (p_scenario, p_design, 'ACCEPTED', '');
  EXCEPTION WHEN others THEN
    INSERT INTO result VALUES (p_scenario, p_design, 'REJECTED', SQLERRM);
  END;
END $$;

-- ---------------------------------------------------------------------
-- (1) BASELINE: polymorphic references without FK
-- ---------------------------------------------------------------------
CREATE SCHEMA baseline;
CREATE TABLE baseline.screen    (id int PRIMARY KEY, name text);
CREATE TABLE baseline.variable  (id int PRIMARY KEY, name text);
CREATE TABLE baseline.component (id int PRIMARY KEY, screen_id int REFERENCES baseline.screen ON DELETE CASCADE, name text);
CREATE TABLE baseline.dependency (id serial PRIMARY KEY,
  source_type text NOT NULL, source_id int NOT NULL,
  target_type text NOT NULL, target_id int NOT NULL, relation_type text NOT NULL);
CREATE TABLE baseline.comment (id serial PRIMARY KEY, element_type text NOT NULL, element_id int NOT NULL, text text NOT NULL);
CREATE TABLE baseline.audit (id serial PRIMARY KEY, entity_type text, entity_id text, action text);
INSERT INTO baseline.screen VALUES (1,'Inicio'),(2,'Detalle');
INSERT INTO baseline.variable VALUES (10,'gUsuario');
INSERT INTO baseline.component VALUES (20,1,'btnGuardar');

-- ---------------------------------------------------------------------
-- (2) ADOPTED: fixtures in the physical model
-- ---------------------------------------------------------------------
INSERT INTO app_user (name, email, password_hash, role) VALUES ('Admin','admin@dept.local','x','ADMINISTRATOR');
INSERT INTO application (name, platform, created_by) VALUES ('SAR','Power Apps',1);        -- element 1 = App (OnStart)
BEGIN;
INSERT INTO documented_element (id, type, application_id) VALUES (2,'SCREEN',1),(3,'SCREEN',1),(10,'VARIABLE',1),(20,'COMPONENT',1);
INSERT INTO screen (id, application_id, name, author_id) VALUES (2,1,'Inicio',1),(3,1,'Detalle',1);
INSERT INTO variable (id, application_id, name, data_type, scope) VALUES (10,1,'gUsuario','RECORD','GLOBAL');
INSERT INTO element_environment VALUES (10,'VARIABLE','DEV');
INSERT INTO component (id, application_id, screen_id, name, type) VALUES (20,1,2,'btnGuardar','Button');
COMMIT;
SELECT setval('documented_element_id_seq', 100);

-- =====================================================================
-- DEPENDENCY
-- =====================================================================
SELECT try_stmt('D1 dependency to a non-existent element', 'baseline',
  $$INSERT INTO baseline.dependency (source_type,source_id,target_type,target_id,relation_type) VALUES ('COMPONENT',20,'VARIABLE',999,'USES')$$);
SELECT try_stmt('D1 dependency to a non-existent element', 'adopted',
  $$INSERT INTO dependency (source_id,source_type,target_id,target_type,relation_type) VALUES (20,'COMPONENT',999,'VARIABLE','USES')$$);

SELECT try_stmt('D2 dependency declaring the wrong type of an element', 'baseline',
  $$INSERT INTO baseline.dependency (source_type,source_id,target_type,target_id,relation_type) VALUES ('SCREEN',20,'SCREEN',1,'NAVIGATES_TO')$$);
SELECT try_stmt('D2 dependency declaring the wrong type of an element', 'adopted',
  $$INSERT INTO dependency (source_id,source_type,target_id,target_type,relation_type) VALUES (20,'SCREEN',2,'SCREEN','NAVIGATES_TO')$$);

SELECT try_stmt('D3 dependency with a misspelled type value', 'baseline',
  $$INSERT INTO baseline.dependency (source_type,source_id,target_type,target_id,relation_type) VALUES ('COMPONNET',20,'VARIABLE',10,'USES')$$);
SELECT try_stmt('D3 dependency with a misspelled type value', 'adopted',
  $$INSERT INTO dependency (source_id,source_type,target_id,target_type,relation_type) VALUES (20,'COMPONNET',10,'VARIABLE','USES')$$);

-- D4: valid dependency, then delete its target -> orphan?
INSERT INTO baseline.dependency (source_type,source_id,target_type,target_id,relation_type) VALUES ('COMPONENT',20,'VARIABLE',10,'USES');
INSERT INTO dependency (source_id,source_type,target_id,target_type,relation_type) VALUES (20,'COMPONENT',10,'VARIABLE','USES');
DELETE FROM baseline.variable WHERE id = 10;
DELETE FROM documented_element WHERE id = 10;
INSERT INTO result SELECT 'D4 target deleted: orphan dependencies left', 'baseline', count(*)::text || ' orphan(s)', 'includes the invalid rows accepted in D1 and D3'
  FROM baseline.dependency d WHERE d.target_type = 'VARIABLE' AND NOT EXISTS (SELECT 1 FROM baseline.variable v WHERE v.id = d.target_id);
INSERT INTO result SELECT 'D4 target deleted: orphan dependencies left', 'adopted', count(*)::text || ' orphan(s)', 'ON DELETE CASCADE'
  FROM dependency d WHERE NOT EXISTS (SELECT 1 FROM documented_element e WHERE e.id = d.target_id);

SELECT try_stmt('D5 phantom element (supertype without subtype) as target', 'adopted',
  $$INSERT INTO documented_element (id, type, application_id) VALUES (50,'VARIABLE',1);
    INSERT INTO dependency (source_id,source_type,target_id,target_type,relation_type) VALUES (20,'COMPONENT',50,'VARIABLE','USES')$$);
INSERT INTO result VALUES ('D5 phantom element (supertype without subtype) as target', 'baseline', 'N/A', 'no supertype exists');

-- =====================================================================
-- COMMENT
-- =====================================================================
SELECT try_stmt('C1 comment on a non-existent screen', 'baseline',
  $$INSERT INTO baseline.comment (element_type, element_id, text) VALUES ('SCREEN', 999, 'x')$$);
SELECT try_stmt('C1 comment on a non-existent screen', 'adopted',
  $$INSERT INTO comment (screen_id, user_id, text) VALUES (999, 1, 'x')$$);

SELECT try_stmt('C2 comment on a variable (not allowed by FR-23)', 'baseline',
  $$INSERT INTO baseline.comment (element_type, element_id, text) VALUES ('VARIABLE', 10, 'x')$$);
SELECT try_stmt('C2 comment on a variable (not allowed by FR-23)', 'adopted',
  $$INSERT INTO comment (screen_id, user_id, text) VALUES (20, 1, 'x')$$);  -- 20 is a component id, not a screen

INSERT INTO baseline.comment (element_type, element_id, text) VALUES ('SCREEN', 2, 'revisar');
INSERT INTO comment (screen_id, user_id, text) VALUES (3, 1, 'revisar');
DELETE FROM baseline.screen WHERE id = 2;
DELETE FROM documented_element WHERE id = 3;
INSERT INTO result SELECT 'C3 screen deleted: orphan comments left', 'baseline', count(*)::text || ' orphan(s)', 'includes the invalid row accepted in C1'
  FROM baseline.comment c WHERE c.element_type = 'SCREEN' AND NOT EXISTS (SELECT 1 FROM baseline.screen s WHERE s.id = c.element_id);
INSERT INTO result SELECT 'C3 screen deleted: orphan comments left', 'adopted', count(*)::text || ' orphan(s)', 'ON DELETE CASCADE'
  FROM comment c WHERE NOT EXISTS (SELECT 1 FROM screen s WHERE s.id = c.screen_id);

-- =====================================================================
-- AUDIT: loose reference ON PURPOSE -> the record must SURVIVE
-- =====================================================================
-- The audit trigger recorded the DELETE of screen 3 (scenario C3); that record must still exist
INSERT INTO result SELECT 'A1 audit record survives deletion of the element', 'adopted',
  CASE WHEN count(*) >= 1 THEN 'SURVIVES' ELSE 'LOST' END, 'written by the audit trigger; no FK to the audited entity'
  FROM audit_log WHERE entity_type = 'screen' AND entity_id = '3' AND action = 'DELETE' AND old_value ->> 'name' = 'Detalle';
-- What a real FK would cause: the delete is blocked (RESTRICT) or the history is erased (CASCADE)
CREATE TABLE baseline.audit_with_fk (entity_id int REFERENCES public.documented_element(id) ON DELETE RESTRICT);
INSERT INTO baseline.audit_with_fk VALUES (2);
SELECT try_stmt('A2 same audit with a real FK (RESTRICT): delete the screen', 'rejected alternative',
  $$DELETE FROM documented_element WHERE id = 2$$);
SELECT try_stmt('A3 audit entity_type outside the audited tables', 'adopted',
  $$INSERT INTO audit_log (db_role, action, entity_type, entity_id) VALUES (session_user,'DELETE','scren','3')$$);

-- ---------------------------------------------------------------------
SET client_min_messages = notice;
\pset tuples_only off
\pset footer off
\pset format aligned
SELECT scenario, design, outcome, left(detail, 90) AS detail FROM result ORDER BY scenario, design;
