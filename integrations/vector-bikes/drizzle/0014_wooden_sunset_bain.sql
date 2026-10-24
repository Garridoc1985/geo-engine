CREATE TABLE "work_order_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"recommendation" text NOT NULL,
	"price_clp" integer NOT NULL,
	"token_hash" text NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decided_ip_hash" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_approvals_price_check" CHECK (price_clp > 0),
	CONSTRAINT "work_order_approvals_decision_check" CHECK ((decided_at is null and decision is null) or (decided_at is not null and decision is not null and decision in ('aprobado', 'rechazado')))
);
--> statement-breakpoint
ALTER TABLE "work_order_items" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "work_order_approvals" ADD CONSTRAINT "work_order_approvals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_approvals" ADD CONSTRAINT "work_order_approvals_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_approvals" ADD CONSTRAINT "work_order_approvals_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_approvals" ADD CONSTRAINT "work_order_approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_order_approvals_token_hash" ON "work_order_approvals" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_work_order_approvals_order" ON "work_order_approvals" USING btree ("work_order_id");--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_approval_id_work_order_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."work_order_approvals"("id") ON DELETE restrict ON UPDATE no action;