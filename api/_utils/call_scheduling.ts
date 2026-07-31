/**
 * Call-scheduling state machine (v3 — 2026-06-18, per the handwritten
 * product note).
 *
 * Rules:
 *   T=0 (lead born):
 *     Trigger call immediately, no time-of-day gate.
 *
 *   PICKED branch:
 *     (a) Customer told a callback time → call at that exact time
 *         (overrides the 7-day lifetime cap — strongest signal).
 *     (b) No time given → call at the next slot from the PICKED hour set
 *         in the customer's timezone. Slots: 10am, 11am, 1pm, 2pm,
 *         4pm, 5pm, 7pm, 8pm. Capped at 7 days from born.
 *
 *   NOT PICKED branch:
 *     Call at the next slot from the NOT_PICKED hour set in the
 *     customer's timezone. Slots: 9am, 10am, 11am, 1pm, 2pm, 4pm,
 *     5pm, 7pm, 8pm. Loops until customer picks up OR 7 days from
 *     born — whichever comes first.
 *
 *   STOP:
 *     "Not Interested" call outcome → Next_Call_At = null permanently.
 *     Lead past 7-day lifetime → Next_Call_At = null permanently.
 *
 *   Other stop conditions enforced outside the scheduler:
 *     - bot_enabled = false  (cron skips lead)
 *     - PRD_Stage in {Not Interested, Spam, Pre Site Visit} (cron skips)
 *     - Sales clears Next_Call_At manually
 *
 * Storage on each Zoho lead (the only field the scheduler writes):
 *   Next_Call_At  datetime  when cron should fire next
 *
 * Legacy Zoho fields kept for back-compat (not read or written by v3):
 *   Consecutive_Missed_Count, Aggressive_Tree_Start_At (from v2 retry tree)
 */

// ─── Country code → IANA timezone (unchanged from v2) ────────────────────
const COUNTRY_TZ: Record<string, string> = {
  "1": "America/New_York",
  "7": "Europe/Moscow",
  "20": "Africa/Cairo",
  "27": "Africa/Johannesburg",
  "30": "Europe/Athens",
  "31": "Europe/Amsterdam",
  "32": "Europe/Brussels",
  "33": "Europe/Paris",
  "34": "Europe/Madrid",
  "39": "Europe/Rome",
  "41": "Europe/Zurich",
  "44": "Europe/London",
  "45": "Europe/Copenhagen",
  "46": "Europe/Stockholm",
  "47": "Europe/Oslo",
  "49": "Europe/Berlin",
  "52": "America/Mexico_City",
  "54": "America/Argentina/Buenos_Aires",
  "55": "America/Sao_Paulo",
  "56": "America/Santiago",
  "57": "America/Bogota",
  "58": "America/Caracas",
  "60": "Asia/Kuala_Lumpur",
  "61": "Australia/Sydney",
  "62": "Asia/Jakarta",
  "63": "Asia/Manila",
  "64": "Pacific/Auckland",
  "65": "Asia/Singapore",
  "66": "Asia/Bangkok",
  "81": "Asia/Tokyo",
  "82": "Asia/Seoul",
  "84": "Asia/Ho_Chi_Minh",
  "86": "Asia/Shanghai",
  "90": "Europe/Istanbul",
  "91": "Asia/Kolkata",
  "92": "Asia/Karachi",
  "93": "Asia/Kabul",
  "94": "Asia/Colombo",
  "95": "Asia/Yangon",
  "234": "Africa/Lagos",
  "254": "Africa/Nairobi",
  "351": "Europe/Lisbon",
  "352": "Europe/Luxembourg",
  "353": "Europe/Dublin",
  "358": "Europe/Helsinki",
  "880": "Asia/Dhaka",
  "960": "Indian/Maldives",
  "961": "Asia/Beirut",
  "962": "Asia/Amman",
  "963": "Asia/Damascus",
  "964": "Asia/Baghdad",
  "965": "Asia/Kuwait",
  "966": "Asia/Riyadh",
  "967": "Asia/Aden",
  "968": "Asia/Muscat",
  "971": "Asia/Dubai",
  "972": "Asia/Jerusalem",
  "973": "Asia/Bahrain",
  "974": "Asia/Qatar",
  "975": "Asia/Thimphu",
  "977": "Asia/Kathmandu",
};

export function lookupTimezone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    if (COUNTRY_TZ[prefix]) return COUNTRY_TZ[prefix];
  }
  return "Asia/Kolkata";
}

// ─── Timezone helpers ────────────────────────────────────────────────────

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
    hour: (+out.hour) % 24, // some locales return 24 for midnight
    minute: +out.minute,
  };
}

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
  const offsetMs = tzMs - guessMs;
  return new Date(guessMs - offsetMs);
}

// ─── Slot configuration (per the product note) ───────────────────────────

/** Hours-of-day (24h) where we fire a call for picked-with-no-time-given.
 *  10am, 11am, 1pm, 2pm, 4pm, 5pm, 7pm, 8pm — skips lunch (12) + 3pm + 6pm. */
const PICKED_NO_TIME_HOURS = [10, 11, 13, 14, 16, 17, 19, 20];

/** Hours-of-day for the not-picked follow-up tree.
 *  9am, 10am, 11am, 1pm, 2pm, 4pm, 5pm, 7pm, 8pm — same as picked plus 9am. */
const NOT_PICKED_HOURS = [9, 10, 11, 13, 14, 16, 17, 19, 20];

/** Hard cap (per product 2026-06-18): stop calling 7 days after lead's
 *  born time. Applies to picked-with-no-time and not-picked branches. A
 *  customer-supplied callback time always wins (overrides the cap) since
 *  it's the strongest engagement signal we have. */
const LEAD_CALL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Find the next "from"-relative slot in the customer's local timezone.
 *  Walks today's remaining slots; if none, jumps to tomorrow's first slot.
 *  Adds a small random jitter (0-10 min) so 100 leads scheduled for "10am"
 *  don't all fire in one cron tick. */
function nextSlot(hours: number[], from: Date, tz: string): Date {
  const p = partsInTz(from, tz);
  // Strict ">": don't reschedule a call that just happened at the same hour.
  const todayHour = hours.find((h) => h > p.hour);
  const jitterMin = Math.floor(Math.random() * 11); // 0..10

  if (todayHour !== undefined) {
    return wallClockToUtc(p.year, p.month, p.day, todayHour, jitterMin, tz);
  }

  // Past last slot today → first slot tomorrow in customer TZ.
  const tomorrow = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const tp = partsInTz(tomorrow, tz);
  return wallClockToUtc(tp.year, tp.month, tp.day, hours[0], jitterMin, tz);
}

// ─── Scheduling outputs ──────────────────────────────────────────────────

export type CallPhase =
  | "FOLLOWUP_AT_TIME"          // picked + customer-given exact time
  | "FOLLOWUP_SLOT"             // picked + no time → next picked-hour slot
  | "MISSED_SLOT"               // not picked → next not-picked-hour slot
  | "STOPPED";                  // "Not Interested" → no more calls

export interface NextCallSchedule {
  nextCallAt: Date | null;
  phase: CallPhase;
  reason: string;
}

/** True when `slot` is past the 7-day call lifetime measured from the
 *  lead's born time. Returns false if createdAt is missing/invalid (i.e.
 *  no cap can be applied — let the call go through). */
function isPastLifetime(slot: Date, createdAt?: string | Date | null): boolean {
  if (!createdAt) return false;
  const born = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (isNaN(born.getTime())) return false;
  const cap = born.getTime() + LEAD_CALL_LIFETIME_MS;
  return slot.getTime() >= cap;
}

/** 0=Sun .. 6=Sat in the given timezone (Intl weekday → index). */
function weekdayInTz(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/**
 * Conservative, TIMEZONE-AWARE parse of the customer's stated callback time.
 * Returns a FUTURE Date, or null (with a warn log) when the value is empty /
 * ambiguous / in the past — the caller then falls back to the slot grid.
 *
 * RCA 2026-07-31 (callbacks firing ~20 min after a "call me Monday"):
 *   the old code did a bare `new Date(preferredCallbackTime)`, which returns
 *   Invalid Date for ANY non-ISO string ("Monday", "tomorrow 3pm", "kal") and
 *   then SILENTLY fell through to the next same-day slot — so a customer who
 *   asked for Monday got re-dialed at the next picked-hour slot (~20 min).
 *   This parser (a) never silently drops — it LOGS every miss, and (b) handles
 *   the common natural-language forms as a safety net until the voice bot emits
 *   proper ISO for `preferred_callback_time`.
 *
 * Order: 1) any Date-parseable / ISO string (the well-behaved-bot happy path);
 *        2) NL in the CUSTOMER tz — weekday names + today/tomorrow/aaj/kal/parso,
 *           with an optional explicit time (am/pm or HH:MM). A day given with no
 *           clear time defaults to 11:00 local (inside the picked-hour set).
 * Anything ambiguous (e.g. a bare "9 baje" with no am/pm) → null + warn, so a
 * BAD guess never dials the customer at the wrong hour.
 */
export function parseCallbackTime(
  raw: string | Date | null | undefined,
  phone: string,
  now: Date = new Date(),
): Date | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;

  // 1) ISO / any natively-parseable datetime — the happy path.
  const direct = new Date(s);
  if (!isNaN(direct.getTime())) return direct;

  // 2) Conservative natural-language, resolved in the customer's timezone.
  const tz = lookupTimezone(phone);
  const lower = s.toLowerCase();

  // Time-of-day — only UNAMBIGUOUS forms (explicit am/pm, or 24h HH:MM).
  let hour: number | null = null;
  let minute = 0;
  const ampm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/);
  const h24 = lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (ampm) {
    hour = (+ampm[1]) % 12;
    if (ampm[3] === "p") hour += 12;
    minute = ampm[2] ? +ampm[2] : 0;
  } else if (h24) {
    hour = +h24[1];
    minute = +h24[2];
  }
  if (hour !== null && (hour < 0 || hour > 23 || minute < 0 || minute > 59)) {
    hour = null;
    minute = 0;
  }

  // Day — relative words first, then weekday names.
  let dayOffset: number | null = null;
  if (/\b(today|aaj|tonight)\b/.test(lower)) dayOffset = 0;
  else if (/\b(day after tomorrow|parso|parson)\b/.test(lower)) dayOffset = 2;
  else if (/\b(tomorrow|tmrw|tmr|kal)\b/.test(lower)) dayOffset = 1;
  else {
    const curDow = weekdayInTz(now, tz);
    for (const name of Object.keys(WEEKDAY_NAMES)) {
      if (new RegExp(`\\b${name}\\b`).test(lower)) {
        let diff = (WEEKDAY_NAMES[name] - curDow + 7) % 7;
        if (diff === 0) diff = 7; // "Monday" spoken on a Monday means NEXT Monday
        dayOffset = diff;
        break;
      }
    }
  }

  if (dayOffset === null && hour === null) {
    console.warn(`[callback-parse] unparseable callback time "${s}" (${tz}) — falling back to slot grid`);
    return null;
  }

  // Build the target wall-clock on the intended calendar day in the customer TZ.
  const todayParts = partsInTz(now, tz);
  const H = hour !== null ? hour : 11; // day given, no clear time → 11:00 local
  const dayShifted = new Date(
    wallClockToUtc(todayParts.year, todayParts.month, todayParts.day, H, minute, tz).getTime() +
      (dayOffset ?? 0) * 24 * 60 * 60 * 1000,
  );
  const tp = partsInTz(dayShifted, tz);
  const target = wallClockToUtc(tp.year, tp.month, tp.day, H, minute, tz);

  if (target.getTime() <= now.getTime()) {
    console.warn(`[callback-parse] parsed "${s}" → ${target.toISOString()} is in the past — falling back to slot grid`);
    return null;
  }
  return target;
}

/** Compute next call after a PICKED call. Customer-specified callback time
 *  always wins (overrides the 7-day lifetime cap — strongest engagement
 *  signal). No-time-given falls into the slot grid + lifetime cap. */
export function nextCallAfterPickup(opts: {
  phone: string;
  preferredCallbackTime?: string | Date | null;
  createdAt?: string | Date | null;
  now?: Date;
}): NextCallSchedule {
  const now = opts.now ?? new Date();
  const tz = lookupTimezone(opts.phone);

  if (opts.preferredCallbackTime) {
    // RCA 2026-07-31: parse via the TZ-aware conservative parser (not a bare
    // `new Date()`), so a natural-language "call me Monday" resolves to Monday
    // instead of silently falling through to the next ~20-min slot. parseCallbackTime
    // returns a FUTURE Date or null (logging every miss).
    const t = parseCallbackTime(opts.preferredCallbackTime, opts.phone, now);
    if (t && t.getTime() > now.getTime()) {
      return {
        nextCallAt: t,
        phase: "FOLLOWUP_AT_TIME",
        reason: `customer-specified callback @ ${t.toISOString()} (${tz}) — overrides 7-day cap`,
      };
    }
  }

  const slot = nextSlot(PICKED_NO_TIME_HOURS, now, tz);
  if (isPastLifetime(slot, opts.createdAt)) {
    return {
      nextCallAt: null,
      phase: "STOPPED",
      reason: `picked + no time → next slot past 7-day cap from born`,
    };
  }
  return {
    nextCallAt: slot,
    phase: "FOLLOWUP_SLOT",
    reason: `picked + no time → ${slot.toISOString()} (${tz})`,
  };
}

/** Compute next call after a MISSED call. Loops on slot hours until pickup
 *  OR until 7 days from lead's born time elapse — whichever comes first. */
export function nextCallAfterMiss(opts: {
  phone: string;
  createdAt?: string | Date | null;
  now?: Date;
}): NextCallSchedule {
  const now = opts.now ?? new Date();
  const tz = lookupTimezone(opts.phone);
  const slot = nextSlot(NOT_PICKED_HOURS, now, tz);
  if (isPastLifetime(slot, opts.createdAt)) {
    return {
      nextCallAt: null,
      phase: "STOPPED",
      reason: `not picked → next slot past 7-day cap from born`,
    };
  }
  return {
    nextCallAt: slot,
    phase: "MISSED_SLOT",
    reason: `not picked → ${slot.toISOString()} (${tz})`,
  };
}

/** Format a Date as Zoho's expected datetime string. */
export function zohoIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** True when the current moment falls within [startHour, endHour) in the
 *  customer's local timezone (resolved from phone). Used by the WhatsApp
 *  follow-up cron to avoid messaging customers at night.
 *
 *  Example: isWithinCustomerHours("+919876543210", 7, 21) returns true
 *  when it's 7AM-9PM in Asia/Kolkata. For +971xxx → 7AM-9PM Dubai time.  */
export function isWithinCustomerHours(
  phone: string,
  startHour: number,
  endHour: number,
  now: Date = new Date(),
): boolean {
  const tz = lookupTimezone(phone);
  const p = partsInTz(now, tz);
  return p.hour >= startHour && p.hour < endHour;
}
