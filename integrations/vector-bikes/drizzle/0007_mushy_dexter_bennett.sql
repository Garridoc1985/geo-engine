CREATE TABLE "bikes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"year" integer,
	"bike_type" text NOT NULL,
	"size" text,
	"color" text,
	"serial_number" text,
	"km_noted" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bikes_type_check" CHECK (bike_type in ('mtb', 'ruta', 'gravel', 'urbana', 'ebike')),
	CONSTRAINT "bikes_year_check" CHECK (year is null or (year >= 1980 and year <= 2100)),
	CONSTRAINT "bikes_km_noted_check" CHECK (km_noted is null or km_noted >= 0)
);
--> statement-breakpoint
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bikes_customer" ON "bikes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_bikes_branch_serial" ON "bikes" USING btree ("branch_id","serial_number");