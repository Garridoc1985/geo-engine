CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"amount_clp" integer NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_kind_check" CHECK (kind in ('abono', 'final')),
	CONSTRAINT "payments_method_check" CHECK (method in ('transferencia', 'tarjeta', 'efectivo', 'otro')),
	CONSTRAINT "payments_amount_check" CHECK (amount_clp > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_one_abono" ON "payments" USING btree ("work_order_id") WHERE kind = 'abono' and voided_at is null;--> statement-breakpoint
CREATE INDEX "idx_payments_branch_received" ON "payments" USING btree ("branch_id","received_at");