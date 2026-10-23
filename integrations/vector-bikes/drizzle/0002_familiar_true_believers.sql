ALTER TABLE "whatsapp_messages" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "reconciliation_note" text;