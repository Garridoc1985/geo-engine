ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP COLUMN "admin_user_id";