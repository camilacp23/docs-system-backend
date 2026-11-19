-- =====================================================================
-- Migration 8 — where a variable is used inside its origin screen (D-134)
-- Command: npx prisma migrate dev --create-only --name variable_origin_used_in, then the CHECK added by hand.
-- `variable.origin_used_in` is an optional, free description of the event or property of the origin screen where the
-- variable is created (for example OnVisible). The row of `screen_variable` with `used_in = 'origin'` is NOT touched:
-- it stays the marker that the variable originates in that screen (trigger ensure_origin_write_link, CHECK
-- screen_variable_origin_is_write_chk, graph and search all depend on it). Audited by the existing trigger of `variable`.
-- Do not edit.
-- =====================================================================
-- AlterTable
ALTER TABLE "variable" ADD COLUMN     "origin_used_in" VARCHAR(200);

-- Never blank, and never the reserved word that marks the origin row (same rule as `used_in` in the contract).
ALTER TABLE "variable" ADD CONSTRAINT "variable_origin_used_in_chk"
  CHECK ("origin_used_in" IS NULL OR (btrim("origin_used_in") <> '' AND "origin_used_in" <> 'origin'));

-- The description belongs to the origin screen: without one it is cleared. This also covers the case the service cannot
-- see, the origin screen being deleted (the foreign key sets origin_screen_id to NULL).
CREATE FUNCTION clear_origin_used_in() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_screen_id IS NULL THEN
    NEW.origin_used_in := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_variable_clear_origin_used_in
BEFORE INSERT OR UPDATE ON variable
FOR EACH ROW EXECUTE FUNCTION clear_origin_used_in();
