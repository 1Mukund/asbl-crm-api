/**
 * ASBL Loft compliance & guardrails — spec section 16.
 *
 * Every outbound communication function must run these checks BEFORE
 * sending. Stop at the first failure (spec ordering matters):
 *   1. Stage terminal (Booked / Closed) → block all
 *   2. Opt_Out_All = true → block all
 *   3. Channel-specific opt-out (Opt_Out_WhatsApp / Opt_Out_Calls)
 *   4. F_Marked_Broker = true → block all
 *   5. WhatsApp service window (24h) — switch to template if expired
 *   6. Rate limit (6 WA/day, 3 calls/day, 1 call per 4h)
 *   7. Communication window (9 AM – 9 PM IST)
 *
 * Decisions return a structured ComplianceCheck so callers can log
 * the reason for skip / defer / abort.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export type ComplianceVerdict =
  | "allow"           // proceed with outreach as planned
  | "switch_to_template" // WA only — service window expired, use template instead
  | "defer"           // outside comm window or rate-limited, retry later
  | "abort";          // terminal / opt-out / broker — never try again

export interface ComplianceCheck {
  verdict: ComplianceVerdict;
  reason: string;
  /** When verdict=defer, the earliest time this channel can retry. */
  retry_after?: string;
}

export type Channel = "whatsapp" | "voice";

const COMM_WINDOW_START_HOUR_IST = 9;
const COMM_WINDOW_END_HOUR_IST = 21;
const WA_DAILY_LIMIT = 6;
const VOICE_DAILY_LIMIT = 3;
const VOICE_INTRA_DAY_GAP_MS = 4 * 60 * 60 * 1000; // 4h between calls

/** Current hour in IST. */
function nowIstHour(): number {
  const utcMs = Date.now();
  const ist = new Date(utcMs + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours();
}

/** Next 9 AM IST as ISO string (for defer retry_after). */
function nextCommWindowStartIso(): string {
  const now = new Date();
  // Convert to IST
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const hour = ist.getUTCHours();
  const isToday = hour < COMM_WINDOW_END_HOUR_IST;
  const next = new Date(ist);
  if (!isToday) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  next.setUTCHours(COMM_WINDOW_START_HOUR_IST, 0, 0, 0);
  // Convert back to UTC
  const utc = new Date(next.getTime() - 5.5 * 60 * 60 * 1000);
  return utc.toISOString();
}

/**
 * Run all guardrail checks for a given outreach attempt.
 * Returns the verdict + structured reason for logging.
 */
export function checkCompliance(opts: {
  lead: any;
  channel: Channel;
  /** True if the planned WA message is a template (not free-form).
   *  Free-form messages must respect the 24h service window. */
  isTemplateMessage?: boolean;
}): ComplianceCheck {
  const { lead, channel, isTemplateMessage } = opts;

  // 1. Stage terminal
  const stage = lead?.Stage;
  if (stage === "Booked" || stage === "Closed") {
    return { verdict: "abort", reason: `stage_terminal:${stage}` };
  }

  // 2. Master opt-out
  if (lead?.F_Opt_Out_All === true) {
    return { verdict: "abort", reason: "opt_out_all" };
  }

  // 3. Channel-specific opt-out
  if (channel === "whatsapp" && lead?.Opt_Out_WhatsApp === true) {
    return { verdict: "abort", reason: "opt_out_whatsapp" };
  }
  if (channel === "voice" && lead?.Opt_Out_Calls === true) {
    return { verdict: "abort", reason: "opt_out_calls" };
  }

  // 4. Broker
  if (lead?.F_Marked_Broker === true) {
    return { verdict: "abort", reason: "marked_broker" };
  }

  // 5. WhatsApp 24h window — free-form must be within window
  if (channel === "whatsapp" && !isTemplateMessage) {
    const expiresAt = lead?.WhatsApp_Service_Window_Expires_At;
    if (expiresAt) {
      const expiry = new Date(expiresAt).getTime();
      if (Number.isFinite(expiry) && Date.now() >= expiry) {
        return { verdict: "switch_to_template", reason: "wa_window_expired" };
      }
    } else {
      // No prior inbound — must use template
      return { verdict: "switch_to_template", reason: "wa_no_prior_inbound" };
    }
  }

  // 6. Rate limits
  if (channel === "whatsapp") {
    const replyCount24h = Number(lead?.WhatsApp_Reply_Count ?? 0) || 0;
    if (replyCount24h >= WA_DAILY_LIMIT) {
      return { verdict: "defer", reason: "wa_daily_limit_hit", retry_after: nextCommWindowStartIso() };
    }
  } else if (channel === "voice") {
    const attemptCount24h = Number(lead?.Call_Attempt_Count ?? 0) || 0;
    if (attemptCount24h >= VOICE_DAILY_LIMIT) {
      return { verdict: "defer", reason: "voice_daily_limit_hit", retry_after: nextCommWindowStartIso() };
    }
    // Voice intra-day 4h gap
    const lastAttempt = lead?.Call_Last_Attempt_At || lead?.Last_Call_At;
    if (lastAttempt) {
      const lastMs = new Date(lastAttempt).getTime();
      if (Number.isFinite(lastMs) && Date.now() - lastMs < VOICE_INTRA_DAY_GAP_MS) {
        const retryAfter = new Date(lastMs + VOICE_INTRA_DAY_GAP_MS).toISOString();
        return { verdict: "defer", reason: "voice_intra_day_gap", retry_after: retryAfter };
      }
    }
  }

  // 7. Communication window (9 AM – 9 PM IST)
  const hour = nowIstHour();
  if (hour < COMM_WINDOW_START_HOUR_IST || hour >= COMM_WINDOW_END_HOUR_IST) {
    return { verdict: "defer", reason: "outside_comm_window", retry_after: nextCommWindowStartIso() };
  }

  return { verdict: "allow", reason: "ok" };
}

// ─── Broker detection (spec section 16.3) ────────────────────────────────
// Multiple signals contribute to a cumulative suspicion score.
// Threshold for F_Marked_Broker = true: score >= 60

const BROKER_KEYWORDS = [
  "commission", "brokerage", "broker", "reseller", "investor pool",
  "channel partner", "cp rate", "site visit ka", "kitna mil",
  "referral fee", "incentive", "channel mgr",
];

export interface BrokerDetectionInput {
  message?: string;
  bot_turn_count?: number;
  recent_response_times_ms?: number[];
  device_fingerprint?: string;
  /** Number of distinct sessions seen with the same fingerprint in last 7d. */
  fingerprint_session_count_7d?: number;
  /** Mismatched intent + budget signal (e.g. "investment" but budget < 1cr). */
  intent_budget_mismatch?: boolean;
}

export interface BrokerDetectionResult {
  suspicion_score: number;
  is_broker: boolean;
  signals: string[];
}

export function detectBrokerSignals(input: BrokerDetectionInput): BrokerDetectionResult {
  let score = 0;
  const signals: string[] = [];

  // Multiple sessions same fingerprint
  if ((input.fingerprint_session_count_7d ?? 0) >= 3) {
    score += 30;
    signals.push(`fingerprint_sessions_7d=${input.fingerprint_session_count_7d}`);
  }

  // Programmatic-fast responses
  if (input.recent_response_times_ms && input.recent_response_times_ms.length >= 3) {
    const fast = input.recent_response_times_ms.filter((t) => t < 2000).length;
    if (fast >= 3) {
      score += 20;
      signals.push(`fast_responses=${fast}`);
    }
  }

  // Broker keywords in message
  const msg = (input.message || "").toLowerCase();
  for (const kw of BROKER_KEYWORDS) {
    if (msg.includes(kw)) {
      score += 50;
      signals.push(`keyword:${kw}`);
      break; // one keyword is enough for max-confidence flag
    }
  }

  // Mismatched intent + budget
  if (input.intent_budget_mismatch) {
    score += 10;
    signals.push("intent_budget_mismatch");
  }

  return {
    suspicion_score: score,
    is_broker: score >= 60,
    signals,
  };
}

/** Best-effort: count how many distinct lead session_ids share this
 *  fingerprint in the last N days. Used by broker detection. */
export async function countSessionsForFingerprint(
  fingerprint: string,
  daysBack = 7,
): Promise<number> {
  if (!fingerprint) return 0;
  if (!SUPABASE_URL || !SUPABASE_KEY) return 0;
  try {
    const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?` +
        `device_fingerprint=eq.${encodeURIComponent(fingerprint)}` +
        `&created_at=gte.${encodeURIComponent(since)}` +
        `&select=session_id&limit=50`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!r.ok) return 0;
    const rows = (await r.json()) as any[];
    if (!Array.isArray(rows)) return 0;
    const unique = new Set(rows.map((x) => x.session_id).filter(Boolean));
    return unique.size;
  } catch {
    return 0;
  }
}
