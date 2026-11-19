-- =====================================================================
-- Migration 7 — onboarding progress (FR-25, D-133)
-- Command: npx prisma migrate dev --create-only --name onboarding_progress, then the CHECK added by hand.
-- One row per onboarding step (1..5) that a user completed in an application.
-- Personal navigation state, not documentation: it has NO audit trigger, on purpose, like refresh_token
-- (every "next" click would otherwise fill audit_log and add an entity type to the audit contract).
-- docs_app gets its DML through the default privileges of migration 4. Do not edit.
-- =====================================================================
-- CreateTable
CREATE TABLE "onboarding_progress" (
    "user_id" INTEGER NOT NULL,
    "application_id" INTEGER NOT NULL,
    "step" SMALLINT NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("user_id","application_id","step")
);

-- CreateIndex
CREATE INDEX "onboarding_progress_application_id_idx" ON "onboarding_progress"("application_id");

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- The onboarding has five steps (SDD Section 7.3, S-38a to S-38c); the contract validates the range first.
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_step_chk" CHECK ("step" BETWEEN 1 AND 5);
