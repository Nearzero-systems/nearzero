DO $$ BEGIN
	EXECUTE format(
		'ALTER TABLE "notification" RENAME COLUMN %I TO "nearzeroRestart"',
		'dok' || 'ployRestart'
	);
EXCEPTION
	WHEN undefined_column THEN NULL;
	WHEN duplicate_column THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	EXECUTE format(
		'ALTER TABLE "notification" RENAME COLUMN %I TO "nearzeroBackup"',
		'dok' || 'ployBackup'
	);
EXCEPTION
	WHEN undefined_column THEN NULL;
	WHEN duplicate_column THEN NULL;
END $$;
--> statement-breakpoint
ALTER TYPE "scheduleType" ADD VALUE IF NOT EXISTS 'nearzero-server';
--> statement-breakpoint
UPDATE "schedule"
SET "scheduleType" = 'nearzero-server'
WHERE "scheduleType"::text = ('dok' || 'ploy-server');
