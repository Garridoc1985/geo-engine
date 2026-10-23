CREATE TABLE "service_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"share_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_service_reports_order" ON "service_reports" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_service_reports_share_token_hash" ON "service_reports" USING btree ("share_token_hash");