ALTER TABLE "git_provider_oauth_state" ADD COLUMN "targetGitProviderId" text;
--> statement-breakpoint
ALTER TABLE "git_provider_oauth_state" ADD CONSTRAINT "git_provider_oauth_state_targetGitProviderId_git_provider_gitProviderId_fk" FOREIGN KEY ("targetGitProviderId") REFERENCES "public"."git_provider"("gitProviderId") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "git_provider_oauth_state_target_idx" ON "git_provider_oauth_state" USING btree ("targetGitProviderId");
