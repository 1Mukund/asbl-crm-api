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
  // 2026-06-19 additions: more corporate / formal AI tells. These were
  // slipping past the original 7 patterns. Each is anchored on the
  // characteristic phrase + trailing punctuation/newline.
  /\bas\s+discussed\b[^.!?\n]*[.!?\n]?/gi,
  /\bas\s+per\s+(my|our)\s+(records?|discussion|conversation)\b[^.!?\n]*[.!?\n]?/gi,
  /\bkindly\s+(note|revert|confirm|advise|share|let\s+(me|us)\s+know)\b[^.!?\n]*[.!?\n]?/gi,
  /\bi\s+would\s+(inform|like\s+to\s+inform|be\s+(delighted|happy))\b[^.!?\n]*[.!?\n]?/gi,
  /\bplease\s+find\s+(attached|below|herewith|the\s+attached)\b[^.!?\n]*[.!?\n]?/gi,
  /\bawaiting\s+your\s+(confirmation|response|reply|reverts?)\b[^.!?\n]*[.!?\n]?/gi,
  /\bwith\s+(regards?|reference)\s+to\s+your\b[^.!?\n]*[.!?\n]?/gi,
  /\bnoted\s+(with\s+thanks|your\s+(request|query)|the\s+same|duly)\b[^.!?\n]*[.!?\n]?/gi,
  /\b(duly|gratefully)\s+noted\b[^.!?\n]*[.!?\n]?/gi,
];

/**
 * Strip mid-conversation re-introduction prefixes. Gemini consistently
 * starts replies with "Hi <name>, picking up on <project> —" even when
 * the prompt forbids it. This post-processor removes that pattern so the
 * customer never sees the bot-y greeting on the 2nd, 3rd, Nth message.
 *
 * Pass `hasHistory = true` only when CONVERSATION_HISTORY had a prior
 * Anandita reply. On the very first turn the greeting stays.
 */
export function stripReintroduction(text: string, hasHistory: boolean): string {
  if (!text || !hasHistory) return text;
  let out = text.trimStart();

  // Patterns Gemini emits — order matters (longest first to catch combos)
  const REINTRO_PATTERNS: RegExp[] = [
    // "Hi <Name>, Anandita here from ASBL. Picking up on <Project> — "
    /^Hi\s+\w+,?\s*Anandita\s+here(?:\s+from\s+ASBL)?[\.,]?\s*(?:Just\s+)?[Pp]icking\s+up\s+(?:on|from)\s+[^.,—\-]+[.,]?\s*[—\-]?\s*/i,
    // "Hi <Name>, picking up on <Project> — "
    /^Hi\s+\w+,?\s*(?:Just\s+)?[Pp]icking\s+up\s+(?:on|from)\s+(?:our\s+last\s+chat|[^.,—\-]+)[.,]?\s*[—\-]?\s*/i,
    // "Hi <Name>, Anandita here from ASBL. "
    /^Hi\s+\w+,?\s*Anandita\s+here(?:\s+from\s+ASBL)?[\.,]?\s*/i,
    // "Hi <Name>. Anandita here. " variants
    /^Hi\s+\w+[.,]?\s*Anandita(?:\s+here)?[.,]?\s*/i,
    // Bare "Hi <Name>, " or "Hi <Name>. "
    /^Hi\s+\w+\s*[.,]?\s*[—\-]?\s*/i,
    // "Picking up on <project> — " without greeting
    /^(?:Just\s+)?[Pp]icking\s+up\s+(?:on|from)\s+(?:our\s+last\s+chat|[^.,—\-]+)[.,]?\s*[—\-]?\s*/i,
    // "Hey <Name>, Anandita again. "
    /^Hey\s+\w+,?\s*Anandita\s+again[.,]?\s*/i,
  ];

  for (const re of REINTRO_PATTERNS) {
    const next = out.replace(re, "");
    if (next !== out) {
      out = next.trimStart();
      // Capitalize the new first letter so the message reads cleanly
      if (out.length && /[a-z]/.test(out[0])) {
        out = out[0].toUpperCase() + out.slice(1);
      }
      break;
    }
  }
  return out;
}

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

  // ── 3. Replace em-dash + en-dash with comma+space ─────────────────────
  // The em-dash (—) is the single biggest AI tell on WhatsApp — humans
  // almost never type it on a phone. Substituting with comma keeps the
  // rhythm but removes the giveaway.
  out = out
    .replace(/\s*—\s*/g, ", ")  // em-dash
    .replace(/\s*–\s*/g, ", ")  // en-dash
    .replace(/(\w)\s*--\s*(\w)/g, "$1, $2");  // double-hyphen used as em-dash

  // ── 4. Cleanup whitespace and orphan punctuation ──────────────────────
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:]){2,}/g, "$1")
    // After em-dash → comma replacement, we sometimes get ", ," sequences.
    .replace(/,\s*,/g, ",")
    .replace(/^\s*,\s*/, "")  // leading comma after stripped phrase
    .trim();

  return out;
}
