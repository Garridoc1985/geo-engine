CREATE TABLE "whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_message_type_check" CHECK (type in ('reminder', 'ready')),
	CONSTRAINT "whatsapp_message_status_check" CHECK (status in ('pending', 'sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_status_check";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "whatsapp_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_whatsapp_booking_type" ON "whatsapp_messages" USING btree ("booking_id","type");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_status" ON "whatsapp_messages" USING btree ("status");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status_check" CHECK (status in ('confirmed', 'ready_for_pickup', 'cancelled', 'completed', 'no_show'));