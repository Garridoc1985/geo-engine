CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_periods_range_check" CHECK ((start_time is null and end_time is null) or (start_time is not null and end_time is not null and start_time < end_time))
);
--> statement-breakpoint
CREATE TABLE "booking_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"block_start" time NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_days" (
	"service_date" date PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"service_date" date NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'America/Santiago' NOT NULL,
	"customer_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"email" text NOT NULL,
	"bike" text NOT NULL,
	"description" text NOT NULL,
	"comuna" text,
	"address" text,
	"pickup_fee_clp" integer DEFAULT 0 NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"cancel_token_hash" text NOT NULL,
	"cancel_token_used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"completed_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_mode_check" CHECK (mode in ('taller', 'retiro')),
	CONSTRAINT "bookings_status_check" CHECK (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
	CONSTRAINT "bookings_cancelled_by_check" CHECK (cancelled_by is null or cancelled_by in ('customer', 'admin')),
	CONSTRAINT "bookings_fee_check" CHECK ((mode = 'taller' and pickup_fee_clp = 0) or (mode = 'retiro' and pickup_fee_clp = 15000)),
	CONSTRAINT "bookings_retiro_address_check" CHECK (mode = 'taller' or (comuna in ('Vitacura', 'Las Condes') and address is not null)),
	CONSTRAINT "bookings_time_order_check" CHECK (ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_blocks" ADD CONSTRAINT "booking_blocks_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_sessions_token_hash" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_users_email" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_blocked_periods_service_date" ON "blocked_periods" USING btree ("service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_booking_blocks_active_slot" ON "booking_blocks" USING btree ("service_date","block_start") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "idx_booking_blocks_booking_id" ON "booking_blocks" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_booking_requests_ip_created" ON "booking_requests" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bookings_code" ON "bookings" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bookings_cancel_token_hash" ON "bookings" USING btree ("cancel_token_hash");--> statement-breakpoint
CREATE INDEX "idx_bookings_service_date_status" ON "bookings" USING btree ("service_date","status");--> statement-breakpoint
CREATE INDEX "idx_bookings_phone_status_starts_at" ON "bookings" USING btree ("phone_e164","status","starts_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_reminder" ON "bookings" USING btree ("service_date","status","reminder_sent_at");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_ip_email_created" ON "login_attempts" USING btree ("ip_hash","email","created_at");