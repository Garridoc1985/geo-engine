/** Datos del taller. Única fuente de verdad para direcciones, contacto y enlaces. */
export const SITE = {
  name: "Vector Bikes",
  streetAddress: "Avenida Kennedy 7666",
  addressShort: "Av. Kennedy 7666, Vitacura",
  locality: "Vitacura",
  region: "Región Metropolitana",
  country: "CL",
  email: "info@vectorbikes.cl",
  phone: "+56985095780",
  phoneDisplay: "+56 9 8509 5780",
  instagramUrl: "https://instagram.com/vector.bikes",
  instagramHandle: "@vector.bikes",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Avenida+Kennedy+7666+Vitacura",
} as const;

/** `null` cuando no hay número configurado: el botón no se renderiza. */
export function whatsappHref(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length < 8 ? null : `https://wa.me/${digits}`;
}
