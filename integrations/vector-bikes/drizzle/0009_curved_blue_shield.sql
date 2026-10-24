CREATE TABLE "work_order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"bike_id" uuid NOT NULL,
	"booking_id" uuid,
	"status" text DEFAULT 'reservada' NOT NULL,
	"requested_service" text NOT NULL,
	"diagnosis" text,
	"observations" text,
	"notes" text,
	"assigned_mechanic_id" uuid,
	"estimated_delivery_date" date,
	"delivery_date_confirmed_at" timestamp with time zone,
	"estimated_minutes" integer DEFAULT 0 NOT NULL,
	"total_clp" integer DEFAULT 0 NOT NULL,
	"paid_clp" integer DEFAULT 0 NOT NULL,
	"qc_approved_at" timestamp with time zone,
	"qc_approved_by" uuid,
	"qc_self_checked" boolean DEFAULT false NOT NULL,
	"warranty_of_order_id" uuid,
	"tax_doc_type" text,
	"tax_doc_number" text,
	"tax_doc_date" date,
	"received_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_number_check" CHECK (number >= 1),
	CONSTRAINT "work_orders_status_check" CHECK (status in ('reservada', 'recibida', 'diagnostico', 'esperando_aprobacion', 'esperando_repuesto', 'en_reparacion', 'control_calidad', 'lista_para_retirar', 'entregada', 'cancelada', 'trabajo_rechazado')),
	CONSTRAINT "work_orders_non_negative_check" CHECK (total_clp >= 0 and paid_clp >= 0 and estimated_minutes >= 0),
	CONSTRAINT "work_orders_delivered_paid_check" CHECK (status <> 'entregada' or paid_clp = total_clp),
	CONSTRAINT "work_orders_qc_check" CHECK (status not in ('lista_para_retirar', 'entregada') or qc_approved_at is not null),
	CONSTRAINT "work_orders_tax_doc_type_check" CHECK (tax_doc_type is null or tax_doc_type in ('boleta', 'factura'))
);
--> statement-breakpoint
ALTER TABLE "work_order_status_history" ADD CONSTRAINT "work_order_status_history_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_status_history" ADD CONSTRAINT "work_order_status_history_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_status_history" ADD CONSTRAINT "work_order_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assigned_mechanic_id_users_id_fk" FOREIGN KEY ("assigned_mechanic_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_qc_approved_by_users_id_fk" FOREIGN KEY ("qc_approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_warranty_of_order_id_work_orders_id_fk" FOREIGN KEY ("warranty_of_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_order_status_history_order_created" ON "work_order_status_history" USING btree ("work_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_orders_branch_number" ON "work_orders" USING btree ("branch_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_orders_booking" ON "work_orders" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_work_orders_branch_status" ON "work_orders" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "idx_work_orders_mechanic_status" ON "work_orders" USING btree ("assigned_mechanic_id","status");--> statement-breakpoint
CREATE INDEX "idx_work_orders_bike" ON "work_orders" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_work_orders_customer" ON "work_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_work_orders_branch_delivery_date" ON "work_orders" USING btree ("branch_id","estimated_delivery_date");