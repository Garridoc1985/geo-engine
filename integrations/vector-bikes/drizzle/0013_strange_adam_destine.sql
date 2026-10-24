CREATE TABLE "order_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"signed_by_name" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_signatures_kind_check" CHECK (kind in ('recepcion', 'entrega'))
);
--> statement-breakpoint
ALTER TABLE "order_signatures" ADD CONSTRAINT "order_signatures_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signatures" ADD CONSTRAINT "order_signatures_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signatures" ADD CONSTRAINT "order_signatures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_signatures_storage_key" ON "order_signatures" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_signatures_order_kind" ON "order_signatures" USING btree ("work_order_id","kind");--> statement-breakpoint
CREATE INDEX "idx_order_signatures_order" ON "order_signatures" USING btree ("work_order_id");