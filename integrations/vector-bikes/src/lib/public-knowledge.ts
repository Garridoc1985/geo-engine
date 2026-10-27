import { z } from "zod";
import knowledge from "../../public/geo/knowledge.json";
import manifest from "../../public/geo/manifest.json";

const publicUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const sourceSchema = z.object({ id: z.string().min(1), reference: publicUrl }).strict();
const itemSchema = z
  .object({
    chunk_id: z.string().min(1),
    document_id: z.string().min(1),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(20000),
    source: sourceSchema,
  })
  .strict();

// El mismo snapshot se compila en Astro y en Netlify Functions, sin lecturas remotas.
export const PUBLIC_KNOWLEDGE = z
  .object({
    schema_version: z.literal("1"),
    company_id: z.literal("vectorbikes"),
    name: z.literal("Vector Bikes"),
    canonical_url: z.literal("https://vectorbikestest.cl/geo/"),
    items: z.array(itemSchema).min(1).max(30),
  })
  .strict()
  .parse(knowledge);

export const KNOWLEDGE_VERSION = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .parse(manifest.content_version);
