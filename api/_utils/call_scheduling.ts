/**
 * Call-scheduling state machine (v3 — 2026-06-18, per the handwritten
 * note from product).
 *
 * Simplified rules:
 *   T=0 (lead born):
 *     Trigger call immediately, no time-of-day gate.
 *
 *   PICKED branch:
 *     (a) Customer told a callback time → call at that exact time.
 *     (b) No time given → call at the next slot from the PICKED hour set
 *         in the customer's timezone. Slots: 10am, 11am, 1pm, 2pm,
 *         4pm, 5pm, 7pm, 8pm.
 *
 *   NOT PICKED branch:
 *     Call at the next slot from the NOT_PICKED hour set in the
 *     customer's timezone. Slots: 9am, 10am, 11am, 1pm, 2pm, 4pm,
 *     5pm, 7pm, 8pm. Loops until customer picks up — no max attempts,
 *     no 3-day exhaustion. Stop conditions handled outside scheduler:
 *       - bot_enabled = false  (cron skips lead)
 *       - PRD_Stage in {Not Interested, Spam, Pre Site Visit} (cron skips)
 *       - Lead_Status = "Not Interested" (posthook clears Next_Call_At)
 *       - Sales clears Next_Call_At manually
 *
 *   STOP:
 *     "Not Interested" call outcome → Next_Call_At = null permanently.
 *
 * What changed from v2 (replaced):
 *   - Removed: 10-min retry, 3-hour aggressive tree, 3-day exhaustion,
 *     Consecutive_Missed_Count, Aggressive_Tree_Start_At usage.
 *   - Cadence is now slot-based on fixed wall-clock hours instead of
 *     interval-based.
 *
 * Storage on each Zoho lead:
 *   - Next_Call_At  datetime  when cron should fire next
 *   - Call_Status   text      latest call's outcome
 *
 * (Consecutive_Missed_Count + Aggressive_Tree_Start_At Zoho fields
 *  still exist for backward compat but are not read or written by v3.)
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

/** Compute next call after a PICKED call. */
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
        reason: `customer-specified callback @ ${t.toISOString()} (${tz})`,
      };
    }
  }

  const slot = nextSlot(PICKED_NO_TIME_HOURS, now, tz);
  return {
    nextCallAt: slot,
    phase: "FOLLOWUP_SLOT",
    reason: `picked + no time → ${slot.toISOString()} (${tz})`,
  };
}

/** Compute next call after a MISSED call. Loops until pickup. */
export function nextCallAfterMiss(opts: {
  phone: string;
  now?: Date;
}): NextCallSchedule {
  const now = opts.now ?? new Date();
  const tz = lookupTimezone(opts.phone);
  const slot = nextSlot(NOT_PICKED_HOURS, now, tz);
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
