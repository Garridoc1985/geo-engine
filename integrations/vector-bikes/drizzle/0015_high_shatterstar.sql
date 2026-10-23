CREATE TABLE "qc_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"result" text NOT NULL,
	"note" text,
	"actor_user_id" uuid NOT NULL,
	"self_check" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_checks_item_key_check" CHECK (item_key in ('frenos', 'cambios', 'ruedas', 'apriete', 'neumaticos', 'prueba_de_rodaje', 'limpieza')),
	CONSTRAINT "qc_checks_result_check" CHECK (result in ('ok', 'falla'))
);
--> statement-breakpoint
ALTER TABLE "qc_checks" ADD CONSTRAINT "qc_checks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_checks" ADD CONSTRAINT "qc_checks_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_checks" ADD CONSTRAINT "qc_checks_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_qc_checks_order_created" ON "qc_checks" USING btree ("work_order_id","created_at");