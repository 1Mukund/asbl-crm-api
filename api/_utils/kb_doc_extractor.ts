/**
 * Auto-extract S3 / Drive / etc. document URLs from a project's KB text
 * (project_facts.facts_text). Maps each URL to a doc_type by scanning the
 * label text immediately preceding the URL.
 *
 * Used by document_dispatcher when a customer requests a doc via the
 * DOCUMENT_REQUEST intent. Saves the user from having to manually populate
 * the project_documents table — single source of truth is the KB.
 */

export interface ExtractedDoc {
  docType: string;
  url: string;
  filename: string | null;
  /** Label text in KB that triggered the match (for debugging) */
  matchedLabel: string;
}

const URL_RE = /https?:\/\/[^\s\)\]<>"'`]+/g;

// Doc-type detection — scan ~80 chars BEFORE each URL for these keywords.
// Order matters: more specific patterns first (e.g. "price sheet" before just "price").
const DOC_TYPE_PATTERNS: Array<{ docType: string; patterns: RegExp[] }> = [
  {
    docType: "price_sheet",
    patterns: [
      /\bprice\s*sheet\b/i,
      /\bcost\s*sheet\b/i,
      /\bpricing\s*sheet\b/i,
      /\bprice\s*list\b/i,
      /\bpricelist\b/i,
    ],
  },
  {
    docType: "payment_structure",
    patterns: [
      /\bpayment\s*structure\b/i,
      /\bpayment\s*plan\b/i,
      /\bpayment\s*schedule\b/i,
      /\bmilestone[s]?\b/i,
      /\bpayment\s*milestones?\b/i,
    ],
  },
  {
    docType: "specifications",
    patterns: [
      /\bspecification[s]?\b/i,
      /\bspecs?\b/i,
      /\bflat\s*specification[s]?\b/i,
    ],
  },
  {
    docType: "master_plan",
    patterns: [
      /\bmaster\s*plan\b/i,
      /\bmasterplan\b/i,
    ],
  },
  {
    docType: "tower_plan",
    patterns: [
      /\btower\s*plan\b/i,
    ],
  },
  {
    docType: "floor_plan",
    patterns: [
      /\bfloor\s*plan\b/i,
      /\bfloorplan\b/i,
      /\bunit\s*plan\b/i,
      /\blayout\b/i,
    ],
  },
  {
    docType: "amenities",
    patterns: [
      /\bamenit(y|ies)\b/i,
      /\bclubhouse\b/i,
    ],
  },
  {
    docType: "brochure",
    patterns: [
      /\bbrochure\b/i,
      /\bbrouchure\b/i,
      /\bbrochur\b/i,
      /\be[-\s]?brochure\b/i,
    ],
  },
];

// Extract a friendly filename from a URL (e.g. "Loft+Brochure.pdf" → "Loft Brochure.pdf")
function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = (u.pathname.split("/").pop() || "").split("?")[0];
    if (!last) return null;
    return decodeURIComponent(last.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Walk the KB text, find every http(s) URL, then categorize each by looking
 * at the ~80 chars of label text immediately before the URL.
 */
export function extractDocsFromKB(kbText: string): ExtractedDoc[] {
  if (!kbText) return [];

  const docs: ExtractedDoc[] = [];
  const seenUrls = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(kbText)) !== null) {
    const rawUrl = match[0].replace(/[.,;:!?\)]+$/, ""); // strip trailing punctuation
    if (seenUrls.has(rawUrl)) continue;

    // Look back ~80 chars for the label
    const start = Math.max(0, match.index - 80);
    const label = kbText.slice(start, match.index);

    let docType = "other";
    let matchedLabel = "";

    for (const { docType: dt, patterns } of DOC_TYPE_PATTERNS) {
      const found = patterns.find((p) => p.test(label));
      if (found) {
        docType = dt;
        const m2 = label.match(found);
        matchedLabel = m2 ? m2[0] : "";
        break;
      }
    }

    seenUrls.add(rawUrl);
    docs.push({
      docType,
      url: rawUrl,
      filename: filenameFromUrl(rawUrl),
      matchedLabel,
    });
  }

  return docs;
}

/**
 * Get the first matching doc for a given doc_type from a project's KB.
 * Returns null if not found.
 */
export function findDocInKB(kbText: string, docType: string): ExtractedDoc | null {
  const all = extractDocsFromKB(kbText);
  return all.find((d) => d.docType === docType) || null;
}

/**
 * Resolve customer's free-form doc-type word (from message or intent)
 * to one of the canonical doc_type slugs we look up.
 */
export function customerWordToDocType(word: string): string | null {
  const w = word.toLowerCase();
  if (/(price\s*sheet|cost\s*sheet|pricelist|price\s*list)/.test(w)) return "price_sheet";
  if (/(payment\s*structure|payment\s*plan|payment\s*schedule|milestone)/.test(w)) return "payment_structure";
  if (/(specification|spec\b|specs)/.test(w)) return "specifications";
  if (/(master\s*plan|masterplan)/.test(w)) return "master_plan";
  if (/(tower\s*plan)/.test(w)) return "tower_plan";
  if (/(floor\s*plan|unit\s*plan|layout|floorplan)/.test(w)) return "floor_plan";
  if (/amenit/.test(w)) return "amenities";
  if (/(brochure|brouchure|brochur)/.test(w)) return "brochure";
  if (/(price|pricing|cost)/.test(w)) return "price_sheet"; // fallback for plain "price"
  if (/details|info|pdf|document/.test(w)) return "brochure"; // generic doc → brochure
  return null;
}
