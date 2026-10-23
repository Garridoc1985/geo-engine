CREATE TABLE "intake_accessories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"description" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"result" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_checks_item_key_check" CHECK (item_key in ('frenos', 'cadena', 'transmision', 'ruedas', 'neumaticos', 'estado_general', 'problemas_visibles')),
	CONSTRAINT "intake_checks_result_check" CHECK (result in ('ok', 'revisar', 'malo'))
);
--> statement-breakpoint
ALTER TABLE "intake_accessories" ADD CONSTRAINT "intake_accessories_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_accessories" ADD CONSTRAINT "intake_accessories_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_accessories" ADD CONSTRAINT "intake_accessories_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_accessories" ADD CONSTRAINT "intake_accessories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_checks" ADD CONSTRAINT "intake_checks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_checks" ADD CONSTRAINT "intake_checks_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_checks" ADD CONSTRAINT "intake_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_intake_accessories_order" ON "intake_accessories" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_intake_checks_order_item" ON "intake_checks" USING btree ("work_order_id","item_key");