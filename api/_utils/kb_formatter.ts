/**
 * KB-style formatter — converts raw extracted-text from a Puppeteer-
 * rendered page into hygenically structured Markdown sections.
 *
 * Goal: take the raw line-by-line text of a /plan or /price page and
 * produce output that reads like a curated Knowledge Base:
 *
 *   ### Section Title
 *   - Pair: Value
 *   - Bullet point
 *   1. Numbered item
 *
 * No LLM call — pure rule-based parser. Used by site_crawler.ts so
 * the LLM (Anandita) sees clean structure as <PROJECT_CONTEXT>.
 */

// Known section heading patterns (case-insensitive, anchored).
// Lines matching any of these become "### <heading>" markers.
const SECTION_PATTERNS: RegExp[] = [
  // Plans page
  /^Unit Plans?$/i,
  /^Luxury\s+\d+\s*BHKs?$/i,
  /^Premium\s+\d+\s*BHKs?$/i,
  /^Comfort\s+\d+\s*BHKs?$/i,
  /^Master Plan$/i,
  /^Tower Plan$/i,
  /^Towers?$/i,
  /^Clubhouse$/i,
  /^Urban Corridor$/i,
  /^Outdoor Living$/i,
  /^Features$/i,

  // Amenities page
  /^Amenities$/i,
  /^Fitness Amenities$/i,
  /^Kids'?\s*Amenities$/i,
  /^Practical Luxury$/i,
  /^Social Amenities$/i,

  // Location page
  /^Connectivity$/i,
  /^Why Financial Dist(rict)?\??$/i,
  /^Nearby$/i,
  /^Find Distance$/i,
  /^Schools?( in (the )?vicinity)?:?$/i,
  /^Offices?( in (the )?vicinity)?:?$/i,
  /^Hospitals?( in (the )?vicinity)?:?$/i,

  // Price page
  /^Price Sheet$/i,
  /^Price Particulars$/i,
  /^Other Charges$/i,
  /^Approved Banks$/i,
  /^Loan Calculator$/i,
  /^Check your Loan Eligibility$/i,
  /^Payment Structure$/i,
  /^Milestone Details$/i,
  /^Pre EMI Offer$/i,

  // Specifications
  /^Flat Specifications$/i,
  /^Specifications$/i,
];

const NOISE_LINES = new Set<string>([
  "BOOK A SITE VISIT",
  "Search",
  "Click to Zoom",
  "Click on the image to zoom in",
  "Click on the tower plan to explore it in detail",
  "Watch Now",
  "Watch the live progress video",
  "Let's talk",
  "Get OTP",
  "GET OTP",
  "Scroll to Top",
  "Smart Assistant",
  "Book a site visit",
  "Book A Site Visit",
  "Explore",
  "Latest Video",
  "Playlist",
  "Gallery",
  "Events",
  "Media",
  "Download PriceSheet",
  "Download Payment Structure!",
  "Note:",
  "GET OTPI agree to receive newsletters, or relevant marketing content and ASBL's Terms and Conditions.",
  "I agree to receive newsletters, or relevant marketing content and ASBL's Terms and Conditions.",
  "You'll receive OTP via WhatsApp and SMS",
  "Can't wait to know more ?",
  "+91",
  "1st Floor",
  "2nd Floor",
  "3rd Floor",
  "4th Floor",
  "5th Floor",
  "Ground Floor",
  "Terrace",
  "2D View",
  "3D View",
  "Check unit story",
  "Check Cost Sheet",
  "Check Unit Story",
  "All Rights Reserved.",
]);

const CURRENCY_OR_NUM = /^[₹$£\d]/;

// Heuristic: is this line likely a value (price, area, percentage, time)?
function looksLikeValue(line: string): boolean {
  return (
    CURRENCY_OR_NUM.test(line) ||
    /\b(sq\.?\s*ft|sft|min|crore|cr|lakh|%)\b/i.test(line) ||
    /^\d+(?:[.,]\d+)?\s*(min|sec|days?|months?|years?|sq|crore|cr|lakh)/i.test(line)
  );
}

// Pair a label line with the immediately following value line: "Label" + "₹9,899"
// becomes "- Label: ₹9,899"
function pairLabelValue(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    const next = lines[i + 1];
    if (
      next &&
      cur.length > 0 &&
      cur.length <= 80 &&
      !looksLikeValue(cur) &&
      looksLikeValue(next) &&
      next.length < 120 &&
      !/[.!?]$/.test(cur)         // skip sentence-like labels
    ) {
      out.push(`- ${cur}: ${next}`);
      i += 2;
    } else {
      out.push(cur);
      i += 1;
    }
  }
  return out;
}

function isSectionHeading(line: string): boolean {
  for (const p of SECTION_PATTERNS) {
    if (p.test(line)) return true;
  }
  return false;
}

function isNoise(line: string): boolean {
  if (NOISE_LINES.has(line)) return true;
  if (line.length < 2) return true;
  if (/^[*•●■▪]+$/.test(line)) return true;     // pure decoration
  if (/^[-–—]+$/.test(line)) return true;
  if (/^\.{2,}$/.test(line)) return true;
  return false;
}

// A numbered list item like "1. Foo" or "12. Bar"
const NUMBERED_RE = /^(\d{1,2})\.\s*(.+)$/;

export interface KBFormatOptions {
  pageLabel: string;
  pageUrl: string;
}

/**
 * Convert raw page text into KB-style structured markdown.
 *
 * Input: raw text with one extracted-line per row (from extractBodyText)
 * Output: ## Page header + ### Section headers + bullet lists
 */
export function formatPageAsKB(rawText: string, opts: KBFormatOptions): string {
  if (!rawText || rawText.trim().length === 0) {
    return `## ${opts.pageLabel}\n   URL: ${opts.pageUrl}\n   (no content)`;
  }

  // Split, trim, drop blanks + noise
  const lines = rawText
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim())  // strip earlier markdown heading prefixes
    .filter((l) => l && !isNoise(l));

  // Group into sections
  type Section = { title: string; body: string[] };
  const sections: Section[] = [{ title: "", body: [] }];

  for (const line of lines) {
    if (isSectionHeading(line)) {
      sections.push({ title: line, body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  // Render each section
  const out: string[] = [];
  out.push(`## ${opts.pageLabel}`);
  out.push(`   URL: ${opts.pageUrl}`);
  out.push("");

  for (const sec of sections) {
    if (sec.body.length === 0 && !sec.title) continue;

    let body = pairLabelValue(sec.body);

    // Convert any bare numbered list lines into proper bullets
    body = body.map((l) => {
      const m = l.match(NUMBERED_RE);
      if (m) return `${m[1]}. ${m[2].trim()}`;
      return l;
    });

    if (sec.title) out.push(`### ${sec.title}`);

    // Output: items already prefixed with `- ` or `\d+.` stay as-is;
    // standalone short lines become bullets if there are multiple.
    const numShort = body.filter((l) => l.length < 80 && !l.startsWith("- ") && !NUMBERED_RE.test(l)).length;
    const shouldBullet = numShort >= 3;

    for (const line of body) {
      if (line.startsWith("- ") || NUMBERED_RE.test(line)) {
        out.push(line);
      } else if (shouldBullet && line.length < 100 && !/[.!?]$/.test(line)) {
        out.push(`- ${line}`);
      } else {
        out.push(line);
      }
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
