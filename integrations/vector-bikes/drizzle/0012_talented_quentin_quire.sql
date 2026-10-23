CREATE TABLE "order_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"retention_class" text NOT NULL,
	"full_key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"full_purged_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_photos_stage_check" CHECK (stage in ('recepcion', 'reparacion', 'terminado')),
	CONSTRAINT "order_photos_retention_check" CHECK ((stage = 'recepcion' and retention_class = 'recepcion_6m') or (stage <> 'recepcion' and retention_class = 'permanente'))
);
--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_photos_full_key" ON "order_photos" USING btree ("full_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_photos_thumb_key" ON "order_photos" USING btree ("thumb_key");--> statement-breakpoint
CREATE INDEX "idx_order_photos_order_stage" ON "order_photos" USING btree ("work_order_id","stage");--> statement-breakpoint
CREATE INDEX "idx_order_photos_retention_created" ON "order_photos" USING btree ("retention_class","created_at");