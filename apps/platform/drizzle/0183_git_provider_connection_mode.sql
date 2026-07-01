CREATE TYPE "public"."gitProviderConnectionMode" AS ENUM('byo', 'nearzero_managed');
--> statement-breakpoint
ALTER TABLE "git_provider" ADD COLUMN "connectionMode" "gitProviderConnectionMode" DEFAULT 'byo' NOT NULL;
--> statement-breakpoint
CREATE TABLE "git_provider_oauth_state" (
	"stateId" text PRIMARY KEY NOT NULL,
	"stateHash" text NOT NULL,
	"providerType" "gitProviderType" NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"returnTo" text,
	"createdAt" text NOT NULL,
	"expiresAt" text NOT NULL,
	"consumedAt" text,
	CONSTRAINT "git_provider_oauth_state_stateHash_unique" UNIQUE("stateHash")
);
--> statement-breakpoint
ALTER TABLE "git_provider_oauth_state" ADD CONSTRAINT "git_provider_oauth_state_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "git_provider_oauth_state" ADD CONSTRAINT "git_provider_oauth_state_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bitbucket" ADD COLUMN "access_token" text;
--> statement-breakpoint
ALTER TABLE "bitbucket" ADD COLUMN "refresh_token" text;
--> statement-breakpoint
ALTER TABLE "bitbucket" ADD COLUMN "expires_at" text;
