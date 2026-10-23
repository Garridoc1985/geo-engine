CREATE TABLE "work_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_clp" integer NOT NULL,
	"estimated_minutes" integer DEFAULT 0 NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_items_kind_check" CHECK (kind in ('servicio', 'repuesto')),
	CONSTRAINT "work_order_items_origin_check" CHECK (origin in ('inicial', 'adicional')),
	CONSTRAINT "work_order_items_quantity_check" CHECK (quantity > 0),
	CONSTRAINT "work_order_items_non_negative_check" CHECK (unit_price_clp >= 0 and estimated_minutes >= 0)
);
--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_order_items_order" ON "work_order_items" USING btree ("work_order_id");