/**
 * offer_time — compute OFFER_TIME_REMAINING for injection into PROJECT_CONTEXT.
 *
 * Each project has an optional offer_end_at timestamp in project_facts.
 * From that we derive a months_remaining number and an urgency_tier that
 * the v5 prompt uses to calibrate the call-to-action ("rental offer runs
 * for another 8 months — happy to lock the unit at today's price").
 *
 *   tier      months_remaining
 *   ─────────────────────────
 *   low       > 12
 *   medium    > 3 and ≤ 12
 *   high      > 0 and ≤ 3
 *   expired   ≤ 0
 *   none      offer_end_at not set
 */

import { getProjectFacts } from "./project_facts";

export type UrgencyTier = "none" | "low" | "medium" | "high" | "expired";

export interface OfferTimeRemaining {
  has_offer: boolean;
  offer_end_at: string | null;     // ISO timestamp or null
  months_remaining: number | null; // rounded to 1 decimal; null when has_offer=false
  urgency_tier: UrgencyTier;
}

const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;

/** Pure compute — useful for tests / direct callers that already have the date. */
export function computeOfferTimeRemainingFromDate(
  offerEndAt: string | Date | null | undefined,
  now: Date = new Date(),
): OfferTimeRemaining {
  if (!offerEndAt) {
    return {
      has_offer: false,
      offer_end_at: null,
      months_remaining: null,
      urgency_tier: "none",
    };
  }
  const end = offerEndAt instanceof Date ? offerEndAt : new Date(offerEndAt);
  if (isNaN(end.getTime())) {
    return {
      has_offer: false,
      offer_end_at: null,
      months_remaining: null,
      urgency_tier: "none",
    };
  }

  const monthsRaw = (end.getTime() - now.getTime()) / MS_PER_MONTH;
  const months = Math.round(monthsRaw * 10) / 10;

  let tier: UrgencyTier = "low";
  if (months <= 0) tier = "expired";
  else if (months <= 3) tier = "high";
  else if (months <= 12) tier = "medium";
  // else stays "low"

  return {
    has_offer: true,
    offer_end_at: end.toISOString(),
    months_remaining: months,
    urgency_tier: tier,
  };
}

/** Look up the project's offer_end_at and compute. Returns the no-offer
 *  shape on any error so callers never have to special-case missing data. */
export async function computeOfferTimeRemaining(
  project: string | null,
): Promise<OfferTimeRemaining> {
  if (!project) {
    return { has_offer: false, offer_end_at: null, months_remaining: null, urgency_tier: "none" };
  }
  try {
    const facts: any = await getProjectFacts(project);
    const offerEndAt = facts?.offer_end_at || null;
    return computeOfferTimeRemainingFromDate(offerEndAt);
  } catch (err: any) {
    console.error(`[OfferTime] compute failed: ${err.message}`);
    return { has_offer: false, offer_end_at: null, months_remaining: null, urgency_tier: "none" };
  }
}

/** Render a compact block for the Gemini PROJECT_CONTEXT.
 *  Returns "" when there's no offer date set, so callers can `if (block) ...`. */
export function renderOfferUrgencyBlock(info: OfferTimeRemaining): string {
  if (!info.has_offer || info.months_remaining === null) return "";

  const lines = [
    "## OFFER_TIME_REMAINING (live calculation — use to calibrate urgency in your CTA)",
    `months_remaining: ${info.months_remaining}`,
    `urgency_tier: ${info.urgency_tier}`,
    `offer_end_at: ${info.offer_end_at}`,
    "",
    "How to use:",
    "- low (>12mo): no urgency; keep CTA soft (\"happy to share more details\")",
    "- medium (3-12mo): mention the offer is time-bound (\"this scheme runs till around <month>\")",
    "- high (≤3mo): drop a clean urgency line (\"only ~X months left on the rental scheme\")",
    "- expired: do NOT mention the offer at all; pivot to standard pitch",
  ];
  return lines.join("\n");
}
