CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rut" text,
	"phone_e164" text NOT NULL,
	"email" text,
	"discovery_channel" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_discovery_channel_check" CHECK (discovery_channel is null or discovery_channel in ('instagram', 'google', 'recomendacion', 'sitio_web', 'paso_por_el_taller', 'otro'))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customers_rut" ON "customers" USING btree ("rut") WHERE rut is not null;--> statement-breakpoint
CREATE INDEX "idx_customers_branch_phone" ON "customers" USING btree ("branch_id","phone_e164");--> statement-breakpoint
CREATE INDEX "idx_customers_branch_name" ON "customers" USING btree ("branch_id","name");