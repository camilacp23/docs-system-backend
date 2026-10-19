-- =====================================================================
-- Append-only check AS THE OWNER ROLE (docs_owner), after 02_*.sql
--   PGPASSWORD=*** psql -h localhost -U docs_owner -d <copy> -f tests/03_owner_immutability_tests.sql
-- =====================================================================
\pset pager off
\set QUIET on
CREATE FUNCTION pg_temp.expect_error(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt; RAISE NOTICE 'FAIL  % (statement was accepted)', label;
  EXCEPTION WHEN others THEN RAISE NOTICE 'PASS  % -> rejected: %', label, SQLERRM; END;
END $$;
SELECT pg_temp.expect_error('AU22 owner UPDATE on audit_log',  $q$UPDATE audit_log SET entity_label = 'x'$q$);
SELECT pg_temp.expect_error('AU23 owner DELETE on audit_log',  $q$DELETE FROM audit_log$q$);
SELECT pg_temp.expect_error('AU24 owner TRUNCATE on audit_log', $q$TRUNCATE audit_log$q$);
