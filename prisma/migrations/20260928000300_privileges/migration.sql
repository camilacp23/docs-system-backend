-- =====================================================================
-- Manual migration 4/4 — least privilege for the API runtime role
-- Created with: npx prisma migrate dev --create-only --name privileges
-- Roles (created once by bootstrap/01_roles_and_database.sql):
--   docs_owner : owns every object; used ONLY by `prisma migrate deploy`
--   docs_app   : used by the Express API at runtime; DML only
-- The runtime role is not the owner, so it cannot ALTER/DROP tables,
-- disable triggers, or change privileges.
-- =====================================================================

GRANT USAGE ON SCHEMA public TO docs_app;

-- DML on domain tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO docs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO docs_app;

-- audit_log: read-only for the API (writes happen through SECURITY DEFINER functions)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log FROM docs_app;
REVOKE USAGE, SELECT ON SEQUENCE audit_log_id_seq FROM docs_app;

-- Prisma's migration history is not the API's business.
-- Guarded: the table does not exist in the shadow database used by
-- `prisma migrate dev`, where an unguarded REVOKE fails with P3006.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public._prisma_migrations FROM docs_app';
  END IF;
END $$;

-- The only way for the API to record a business event
GRANT EXECUTE ON FUNCTION log_business_event(text, text, text, text, jsonb, int) TO docs_app;

-- Tables created by future migrations get the same DML grant automatically.
-- (A future table that must be read-only, like audit_log, needs an explicit REVOKE.)
ALTER DEFAULT PRIVILEGES FOR ROLE docs_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE docs_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO docs_app;
