/**
 * Call-scheduling state machine (PRD v2.0 — 2026-06-18 product call).
 *
 * Rules (verbatim from user):
 *   - Lead aate hi: call lagao turant (T=0). Handled outside this file —
 *     `handleLeadCreated` already fires the first call.
 *   - PICKED branch:
 *       (a) Customer told a callback time → call at that time. India phone
 *           → IST. International → customer's local TZ.
 *       (b) Customer didn't tell a time → next day random slot between
 *           8 AM and 9 PM in customer's TZ.
 *   - NOT PICKED branch:
 *       (a) First miss → retry 10 minutes later.
 *       (b) Second miss → enter the 3-day aggressive tree: every 3 hours
 *           between 7 AM and 9 PM in customer's TZ, for 3 days.
 *       (c) After 3 days → exhausted, stop.
 *
 *   Old PRD v1.0 SS-call gate (3 attempts × 4h) is REPLACED by this.
 *
 * Storage on each Zoho lead (3 custom fields — created via
 * /api/chat-history?action=zoho-create-call-scheduling-fields):
 *   - Next_Call_At              datetime   when cron should fire next
 *   - Consecutive_Missed_Count  integer    miss streak since last pickup
 *   - Aggressive_Tree_Start_At  datetime   set when aggressive tree began
 *
 * Cron logic (api/cron/followup.ts): if Next_Call_At is set and now >=
 * Next_Call_At, fire the call. Posthook (api/relay/inhouse-posthook.ts)
 * runs computeNextCallSchedule below and PATCHes those fields.
 */

// ─── Country code → IANA timezone ────────────────────────────────────────
// Longest-prefix-first matching: lookupTimezone tries 3-digit codes
// before 2-digit before 1-digit so "971" (UAE) wins over "97".
// Ambiguous countries (US/Canada=+1, Russia=+7) default to a single zone
// because we don't get area code from the phone number alone — good
// enough for follow-up call windows.
const COUNTRY_TZ: Record<string, string> = {
  // Single-digit codes (longest fallback)
  "1": "America/New_York",      // US/Canada — default to Eastern Time
  "7": "Europe/Moscow",         // Russia/Kazakhstan — default Moscow

  // Two-digit codes
  "20": "Africa/Cairo",         // Egypt
  "27": "Africa/Johannesburg",  // South Africa
  "30": "Europe/Athens",        // Greece
  "31": "Europe/Amsterdam",     // Netherlands
  "32": "Europe/Brussels",      // Belgium
  "33": "Europe/Paris",         // France
  "34": "Europe/Madrid",        // Spain
  "39": "Europe/Rome",          // Italy
  "41": "Europe/Zurich",        // Switzerland
  "44": "Europe/London",        // UK
  "45": "Europe/Copenhagen",    // Denmark
  "46": "Europe/Stockholm",     // Sweden
  "47": "Europe/Oslo",          // Norway
  "49": "Europe/Berlin",        // Germany
  "52": "America/Mexico_City",  // Mexico
  "54": "America/Argentina/Buenos_Aires",
  "55": "America/Sao_Paulo",    // Brazil
  "56": "America/Santiago",     // Chile
  "57": "America/Bogota",       // Colombia
  "58": "America/Caracas",      // Venezuela
  "60": "Asia/Kuala_Lumpur",    // Malaysia
  "61": "Australia/Sydney",     // Australia — default Sydney
  "62": "Asia/Jakarta",         // Indonesia
  "63": "Asia/Manila",          // Philippines
  "64": "Pacific/Auckland",     // New Zealand
  "65": "Asia/Singapore",       // Singapore
  "66": "Asia/Bangkok",         // Thailand
  "81": "Asia/Tokyo",           // Japan
  "82": "Asia/Seoul",           // South Korea
  "84": "Asia/Ho_Chi_Minh",     // Vietnam
  "86": "Asia/Shanghai",        // China
  "90": "Europe/Istanbul",      // Turkey
  "91": "Asia/Kolkata",         // India ⭐
  "92": "Asia/Karachi",         // Pakistan
  "93": "Asia/Kabul",           // Afghanistan
  "94": "Asia/Colombo",         // Sri Lanka
  "95": "Asia/Yangon",          // Myanmar

  // Three-digit codes (must come after 1/2-digit for substring fallback)
  "234": "Africa/Lagos",        // Nigeria
  "254": "Africa/Nairobi",      // Kenya
  "351": "Europe/Lisbon",       // Portugal
  "352": "Europe/Luxembourg",
  "353": "Europe/Dublin",       // Ireland
  "358": "Europe/Helsinki",     // Finland
  "880": "Asia/Dhaka",          // Bangladesh
  "960": "Indian/Maldives",     // Maldives
  "961": "Asia/Beirut",         // Lebanon
  "962": "Asia/Amman",          // Jordan
  "963": "Asia/Damascus",       // Syria
  "964": "Asia/Baghdad",        // Iraq
  "965": "Asia/Kuwait",         // Kuwait
  "966": "Asia/Riyadh",         // Saudi Arabia
  "967": "Asia/Aden",           // Yemen
  "968": "Asia/Muscat",         // Oman
  "971": "Asia/Dubai",          // UAE ⭐ (a lot of NRI ASBL leads)
  "972": "Asia/Jerusalem",      // Israel
  "973": "Asia/Bahrain",        // Bahrain
  "974": "Asia/Qatar",          // Qatar
  "975": "Asia/Thimphu",        // Bhutan
  "977": "Asia/Kathmandu",      // Nepal
};

/** Resolve a phone to an IANA timezone. Strips +/spaces/dashes, then tries
 *  the longest country-code prefix that matches. Defaults to India for
 *  unrecognised numbers (matches the bulk of our lead base). */
export function lookupTimezone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  // Try 3-digit first, then 2, then 1 (longest-prefix wins).
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    if (COUNTRY_TZ[prefix]) return COUNTRY_TZ[prefix];
  }
  return "Asia/Kolkata";
}

// ─── Timezone math helpers ───────────────────────────────────────────────

/** Extract wall-clock components (Y/M/D/H/M) of a UTC Date as seen in the
 *  given IANA timezone. */
function partsInTz(d: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    // Intl can return "24" for midnight in en-CA depending on locale —
    // normalise to 0 to match standard 0-23 convention.
    hour: (+out.hour) % 24,
    minute: +out.minute,
  };
}

/** Convert a wall-clock time in a given timezone to a UTC Date. Uses one
 *  TZ-offset probe + correction to handle DST edges. */
function wallClockToUtc(
  y: number, mo: number, d: number, h: number, mi: number, tz: string,
): Date {
  const guessMs = Date.UTC(y, mo - 1, d, h, mi);
  const guessDate = new Date(guessMs);
  const tzParts = partsInTz(guessDate, tz);
  const tzMs = Date.UTC(
    tzParts.year, tzParts.month - 1, tzParts.day,
    tzParts.hour, tzParts.minute,
  );
  // Offset = how much "ahead" the TZ wall clock is vs UTC for this moment
  const offsetMs = tzMs - guessMs;
  return new Date(guessMs - offsetMs);
}

/** Returns the next moment that's inside [startHour, endHour) in the given
 *  timezone, starting from `from`. If `from` is already inside the window,
 *  returns `from` unchanged. */
function nextWithinWindow(
  from: Date, tz: string, startHour: number, endHour: number,
): Date {
  const p = partsInTz(from, tz);
  if (p.hour >= startHour && p.hour < endHour) {
    return from;
  }
  // After window today → tomorrow's startHour; before window → today's startHour
  let tgt = { ...p };
  if (p.hour >= endHour) {
    const tomorrow = new Date(from.getTime() + 24 * 3600 * 1000);
    tgt = partsInTz(tomorrow, tz);
  }
  return wallClockToUtc(tgt.year, tgt.month, tgt.day, startHour, 0, tz);
}

// ─── Window constants (per spec) ─────────────────────────────────────────
const AGGRESSIVE_WINDOW_START_HOUR = 7;   // 7 AM customer-local
const AGGRESSIVE_WINDOW_END_HOUR   = 21;  // 9 PM customer-local (exclusive)
const PICKUP_WINDOW_START_HOUR     = 8;   // 8 AM customer-local
const PICKUP_WINDOW_END_HOUR       = 21;  // 9 PM customer-local (exclusive)
const FIRST_RETRY_DELAY_MS         = 10 * 60 * 1000;       // 10 min
const AGGRESSIVE_RETRY_INTERVAL_MS = 3  * 60 * 60 * 1000;  // 3 h
const AGGRESSIVE_TREE_DURATION_MS  = 3  * 24 * 60 * 60 * 1000; // 3 days

// ─── Scheduling outputs ──────────────────────────────────────────────────

export type CallPhase =
  | "FOLLOWUP_AT_TIME"          // picked + customer gave time
  | "FOLLOWUP_NEXT_DAY"         // picked + no time
  | "RETRY_10MIN"               // not picked, 1st miss
  | "AGGRESSIVE_TREE"           // not picked, 2nd+ miss within 3-day window
  | "EXHAUSTED";                // not picked, 3-day window past

export interface NextCallSchedule {
  nextCallAt: Date | null;       // null when EXHAUSTED
  phase: CallPhase;
  consecutiveMissedCount: number;
  aggressiveTreeStartAt: Date | null;
  reason: string;                // human-readable, for logs/debug
}

/** Compute next call time after a PICKED call.
 *  Resets miss streak + aggressive tree state. */
export function nextCallAfterPickup(opts: {
  phone: string;
  preferredCallbackTime?: string | Date | null;
  now?: Date;
}): NextCallSchedule {
  const now = opts.now ?? new Date();
  const tz = lookupTimezone(opts.phone);

  if (opts.preferredCallbackTime) {
    const t = opts.preferredCallbackTime instanceof Date
      ? opts.preferredCallbackTime
      : new Date(opts.preferredCallbackTime);
    if (!isNaN(t.getTime()) && t.getTime() > now.getTime()) {
      return {
        nextCallAt: t,
        phase: "FOLLOWUP_AT_TIME",
        consecutiveMissedCount: 0,
        aggressiveTreeStartAt: null,
        reason: `customer-specified callback @ ${t.toISOString()} (${tz})`,
      };
    }
  }

  // No (or invalid) preferred time → next day, random slot inside
  // [8 AM, 9 PM) customer-local. Random minute prevents thundering-herd
  // load if many leads were picked in the same hour.
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tp = partsInTz(tomorrow, tz);
  const hour = PICKUP_WINDOW_START_HOUR
    + Math.floor(Math.random() * (PICKUP_WINDOW_END_HOUR - PICKUP_WINDOW_START_HOUR));
  const minute = Math.floor(Math.random() * 60);
  const nextCallAt = wallClockToUtc(tp.year, tp.month, tp.day, hour, minute, tz);
  return {
    nextCallAt,
    phase: "FOLLOWUP_NEXT_DAY",
    consecutiveMissedCount: 0,
    aggressiveTreeStartAt: null,
    reason: `no time given → tomorrow ${hour}:${String(minute).padStart(2, "0")} ${tz}`,
  };
}

/** Compute next call time after a MISSED call. Uses miss streak + the
 *  aggressive-tree start timestamp to decide phase. */
export function nextCallAfterMiss(opts: {
  phone: string;
  currentConsecutiveMissed: number;   // BEFORE this miss
  currentAggressiveTreeStartAt?: string | Date | null;
  now?: Date;
}): NextCallSchedule {
  const now = opts.now ?? new Date();
  const tz = lookupTimezone(opts.phone);
  const missAfter = opts.currentConsecutiveMissed + 1;

  // 1st consecutive miss → 10-min retry
  if (missAfter === 1) {
    return {
      nextCallAt: new Date(now.getTime() + FIRST_RETRY_DELAY_MS),
      phase: "RETRY_10MIN",
      consecutiveMissedCount: 1,
      aggressiveTreeStartAt: null,
      reason: "1st miss → retry in 10 min",
    };
  }

  // 2nd+ miss → aggressive tree. Set start timestamp on entry; keep it
  // across subsequent ticks so we can window-check.
  const treeStart = opts.currentAggressiveTreeStartAt
    ? new Date(opts.currentAggressiveTreeStartAt)
    : now;
  const treeEnd = new Date(treeStart.getTime() + AGGRESSIVE_TREE_DURATION_MS);

  if (now.getTime() >= treeEnd.getTime()) {
    return {
      nextCallAt: null,
      phase: "EXHAUSTED",
      consecutiveMissedCount: missAfter,
      aggressiveTreeStartAt: treeStart,
      reason: `3-day aggressive tree expired (started ${treeStart.toISOString()})`,
    };
  }

  // Next attempt = now + 3h, clamped into the 7 AM-9 PM customer-local
  // window. If that pushes past treeEnd, we exhaust.
  const candidate = new Date(now.getTime() + AGGRESSIVE_RETRY_INTERVAL_MS);
  const nextSlot = nextWithinWindow(
    candidate, tz, AGGRESSIVE_WINDOW_START_HOUR, AGGRESSIVE_WINDOW_END_HOUR,
  );

  if (nextSlot.getTime() >= treeEnd.getTime()) {
    return {
      nextCallAt: null,
      phase: "EXHAUSTED",
      consecutiveMissedCount: missAfter,
      aggressiveTreeStartAt: treeStart,
      reason: `next slot ${nextSlot.toISOString()} past tree end`,
    };
  }

  return {
    nextCallAt: nextSlot,
    phase: "AGGRESSIVE_TREE",
    consecutiveMissedCount: missAfter,
    aggressiveTreeStartAt: treeStart,
    reason: `miss #${missAfter} → next ${nextSlot.toISOString()} (${tz})`,
  };
}

/** Format a Date as Zoho's expected datetime string (ISO with offset, no
 *  millis). matches helpers used elsewhere in the codebase. */
export function zohoIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
