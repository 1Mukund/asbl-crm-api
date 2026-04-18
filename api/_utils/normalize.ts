// Known country codes with their digit lengths
const COUNTRY_CODES: { code: string; digits: number }[] = [
  { code: "971", digits: 12 }, // UAE
  { code: "966", digits: 12 }, // Saudi Arabia
  { code: "974", digits: 11 }, // Qatar
  { code: "968", digits: 11 }, // Oman
  { code: "973", digits: 11 }, // Bahrain
  { code: "965", digits: 11 }, // Kuwait
  { code: "962", digits: 11 }, // Jordan
  { code: "44",  digits: 12 }, // UK
  { code: "61",  digits: 11 }, // Australia
  { code: "65",  digits: 10 }, // Singapore
  { code: "49",  digits: 12 }, // Germany
  { code: "33",  digits: 11 }, // France
  { code: "81",  digits: 11 }, // Japan
  { code: "86",  digits: 13 }, // China
  { code: "20",  digits: 12 }, // Egypt
  { code: "1",   digits: 11 }, // US/Canada
];

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, "");

  // 10 digits → assume Indian
  if (digits.length === 10) return "91" + digits;

  // 11 digits starting with 0 → Indian STD format
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);

  // 12 digits starting with 91 → Indian
  if (digits.length === 12 && digits.startsWith("91")) return digits;

  // Match known country codes
  for (const { code } of COUNTRY_CODES) {
    if (digits.startsWith(code)) return digits;
  }

  // Fallback
  return digits.length >= 7 ? digits : null;
}

export function isIndianNumber(phone: string | null): boolean {
  return !!phone && phone.startsWith("91") && phone.length === 12;
}

export function parseName(fullName: string | null | undefined): { first_name: string; last_name: string } {
  if (!fullName?.trim()) return { first_name: "", last_name: "" };
  const parts = fullName.trim().split(/\s+/);
  return {
    first_name: parts[0],
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : parts[0],
  };
}

export function detectProject(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("loft"))     return "LOFT";
  if (t.includes("spectra"))  return "SPECTRA";
  if (t.includes("broadway")) return "BROADWAY";
  if (t.includes("landmark")) return "LANDMARK";
  if (t.includes("legacy"))   return "LEGACY";
  return null;
}
