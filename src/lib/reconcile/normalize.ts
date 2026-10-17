export type DocNumberRules = {
  ignore_separators?: boolean;
  strip_leading_zeros?: boolean;
  strip_prefixes?: string[];
};

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/**
 * Normalise a document number so that INV-0418, inv 0418 and ٠٤١٨ can be compared.
 * The original value is always kept separately; this is only used for matching.
 */
export function normalizeDocNumber(raw: string, rules: DocNumberRules = {}): string {
  let s = raw.normalize("NFKC").trim().toUpperCase();

  s = s.replace(/[٠-٩]/g, (c) => String(ARABIC_INDIC.indexOf(c)));
  s = s.replace(/[۰-۹]/g, (c) => String(EASTERN_ARABIC_INDIC.indexOf(c)));
  s = s.replace(/\s+/g, "");

  if (rules.ignore_separators !== false) s = s.replace(/[-/\\._]/g, "");

  for (const prefix of rules.strip_prefixes ?? []) {
    const p = prefix.toUpperCase().replace(/[-/\\._\s]/g, "");
    if (p && s.startsWith(p) && s.length > p.length) {
      s = s.slice(p.length);
      break;
    }
  }

  if (rules.strip_leading_zeros) s = s.replace(/^0+(?=.)/, "");
  return s;
}
