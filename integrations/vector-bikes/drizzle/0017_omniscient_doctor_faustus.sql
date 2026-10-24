CREATE TABLE "bike_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"bike_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"work_order_item_id" uuid,
	"component_type" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"serial_number" text,
	"installed_at" date NOT NULL,
	"price_clp" integer DEFAULT 0 NOT NULL,
	"replaced_at" date,
	"replaced_by_component_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bike_components_price_check" CHECK (price_clp >= 0),
	CONSTRAINT "bike_components_replaced_date_check" CHECK (replaced_at is null or replaced_at >= installed_at)
);
--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_work_order_item_id_work_order_items_id_fk" FOREIGN KEY ("work_order_item_id") REFERENCES "public"."work_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_replaced_by_component_id_bike_components_id_fk" FOREIGN KEY ("replaced_by_component_id") REFERENCES "public"."bike_components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bike_components" ADD CONSTRAINT "bike_components_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bike_components_bike_installed" ON "bike_components" USING btree ("bike_id","installed_at");--> statement-breakpoint
CREATE INDEX "idx_bike_components_order" ON "bike_components" USING btree ("work_order_id");