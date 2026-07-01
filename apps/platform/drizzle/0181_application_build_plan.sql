ALTER TABLE "application" ADD COLUMN "buildSelectionMode" text;
UPDATE "application" SET "buildSelectionMode" = 'explicit';
ALTER TABLE "application" ALTER COLUMN "buildSelectionMode" SET DEFAULT 'automatic';
ALTER TABLE "application" ALTER COLUMN "buildSelectionMode" SET NOT NULL;
ALTER TABLE "deployment" ADD COLUMN "buildPlan" jsonb;
