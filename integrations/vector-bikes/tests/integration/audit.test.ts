import { expect, it } from "vitest";
import { redactDetails } from "../../src/server/taller/audit.ts";

it.each([
  "ana.perez+alias@example.cl",
  "12345678-9123-4567-8912-912345678901@example.cl",
  "+56 9 1234 5678",
  "912345678",
  "9.1234-5678",
  "+56912345678",
  "56-9-1234-5678",
  "12.345.678-9",
  "12345678-9",
  "1.234.567-K",
  "1234567-k",
])("redacta %s dentro de una frase", (detail) => {
  expect(redactDetails({ note: `Contactar ${detail} mañana.` })).toEqual({
    note: "Contactar [redactado] mañana.",
  });
});

it("redacta varios datos en un mismo texto", () => {
  expect(redactDetails("Correo ana@example.cl, teléfono +56 9 1234 5678, RUT 12345678-K.")).toBe(
    "Correo [redactado], teléfono [redactado], RUT [redactado].",
  );
});

it("conserva UUID completos aunque contengan segmentos que parecen RUT o teléfono", () => {
  const ids = [
    "00000000-0000-4000-8000-000000000061",
    "12345678-9123-4567-8912-912345678901",
    "91234567-8abc-4def-9123-123456789012",
  ];
  for (const id of ids)
    expect(redactDetails(`Orden ${id}; ana@example.cl.`)).toBe(`Orden ${id}; [redactado].`);
});

it("conserva montos, palabras, números cortos y tipos no string", () => {
  const value = {
    note: "Ajuste por 15000 pesos, total 15000. Revisar frenos.",
    amount: 15000,
    ok: true,
    absent: null,
  };
  expect(redactDetails(value)).toEqual(value);
});

it("mantiene la regla por nombre de clave y recurre por objetos y arrays", () => {
  const value = {
    email: "cualquier valor",
    phoneE164: null,
    RUT: 123,
    token: "secreto",
    password: "secreto",
    correo: "secreto",
    telefono: "secreto",
    clave: "secreto",
    nested: [
      { note: "Llamar 9-1234-5678", deeper: { description: "RUT 12345678-K", value: "15000" } },
      "ana@example.cl",
    ],
  };
  expect(redactDetails(value)).toEqual({
    email: "[redactado]",
    phoneE164: "[redactado]",
    RUT: "[redactado]",
    token: "[redactado]",
    password: "[redactado]",
    correo: "[redactado]",
    telefono: "[redactado]",
    clave: "[redactado]",
    nested: [
      { note: "Llamar [redactado]", deeper: { description: "RUT [redactado]", value: "15000" } },
      "[redactado]",
    ],
  });
  expect(value.nested[1]).toBe("ana@example.cl");
});
