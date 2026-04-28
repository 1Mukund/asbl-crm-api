/**
 * Response sanitizer — strips markdown formatting and banned corporate
 * phrases from LLM output before it reaches WhatsApp.
 *
 * Belt-and-suspenders defense in case the LLM slips past prompt rules.
 */

const BANNED_PATTERNS: Array<RegExp> = [
  // "How can I help / assist [you] [today / with X]?"
  /\bhow\s+(can|may)\s+(i|we)\s+(help|assist)(\s+you)?(\s+(today|with[^?.\n]*))?\s*\??/gi,
  // "Feel free to ..."
  /\bfeel\s+free\s+to\s+[^.!?\n]*[.!?\n]/gi,
  // "Do not hesitate to ..."
  /\bdo(\s+not|n['']?t)\s+hesitate\s+to\s+[^.!?\n]*[.!?\n]/gi,
  // "I am / I'm here to assist you (today/with X)"
  /\bi(\s+am|['']?m)\s+here\s+to\s+(assist|help)(\s+you)?(\s+(with[^.!?\n]*|today))?[.!?\n]/gi,
  // "Rest assured ..."
  /\brest\s+assured[^.!?\n]*[.!?\n]/gi,
  // "Happy to help"
  /\bhappy\s+to\s+help[^.!?\n]*[.!?\n]?/gi,
  // "It would be my pleasure to ..."
  /\bit\s+(would|will)\s+be\s+my\s+pleasure\s+to\s+[^.!?\n]*[.!?\n]/gi,
];

export function sanitizeReply(text: string): string {
  if (!text) return text;
  let out = text;

  // ── 1. Strip markdown formatting ──────────────────────────────────────
  out = out
    // Bold: **text** or __text__
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // Italic: *text* or _text_ (avoid breaking inside words)
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, "$1")
    // Inline code: `text`
    .replace(/`([^`\n]+)`/g, "$1")
    // Headings: ## text → text
    .replace(/^#{1,6}\s+/gm, "")
    // Bullet points: lines starting with - or * or • → strip marker
    .replace(/^[\s]*[-*•]\s+/gm, "")
    // Numbered lists: "1. text" → "text"
    .replace(/^[\s]*\d+\.\s+/gm, "");

  // ── 2. Strip banned corporate phrases ─────────────────────────────────
  for (const pattern of BANNED_PATTERNS) {
    out = out.replace(pattern, "");
  }

  // ── 3. Cleanup whitespace and orphan punctuation ──────────────────────
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:]){2,}/g, "$1")
    .trim();

  return out;
}
