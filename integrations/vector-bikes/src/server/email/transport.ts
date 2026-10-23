import { Resend } from "resend";
import { type EmailEnv, getEmailEnv } from "../../lib/env.ts";
import { log } from "../../lib/log.ts";

export type EmailAttachment = {
  filename: string;
  /** Texto plano; el transporte `resend` lo codifica en base64. */
  content: string;
  contentType: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
};

export type OutboxEntry = EmailMessage & { from: string; replyTo: string };

export type EmailTransport = {
  send: (message: EmailMessage) => Promise<void>;
};

/** Correos del transporte `console`. Los tests lo leen y lo vacían; nunca sale a la red. */
export const consoleOutbox: OutboxEntry[] = [];

type ResendPayload = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
};

export function toResendPayload(message: EmailMessage, env: EmailEnv): ResendPayload {
  const payload: ResendPayload = {
    from: env.EMAIL_FROM,
    to: message.to,
    replyTo: env.EMAIL_REPLY_TO,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.attachments && message.attachments.length > 0) {
    payload.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.content, "utf8").toString("base64"),
      contentType: attachment.contentType,
    }));
  }
  return payload;
}

function consoleTransport(env: EmailEnv): EmailTransport {
  return {
    send: async (message) => {
      consoleOutbox.push({ ...message, from: env.EMAIL_FROM, replyTo: env.EMAIL_REPLY_TO });
      log.info("email.console", { subject: message.subject });
    },
  };
}

function resendTransport(env: EmailEnv): EmailTransport {
  const client = new Resend(env.RESEND_API_KEY);
  return {
    send: async (message) => {
      const { error } = await client.emails.send(toResendPayload(message, env));
      if (error) {
        throw new Error(`Resend rechazó el correo: ${error.message}`);
      }
    },
  };
}

export function createTransport(env: EmailEnv = getEmailEnv()): EmailTransport {
  return env.EMAIL_TRANSPORT === "resend" ? resendTransport(env) : consoleTransport(env);
}
