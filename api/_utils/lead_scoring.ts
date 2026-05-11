/**
 * ASBL Loft lead scoring — spec section 11 (fn_ComputeLeadScore).
 *
 * Score range 0–100 → Lead_Tier (Hot / Warm / Cold / Disqualified).
 * Predicted_Value_INR derived from tier × project ASP — used by Meta CAPI
 * + Google OCI for value-based bidding (spec section 15.4).
 *
 * Called after every meaningful slot capture (intent / budget / timeline /
 * configuration changes). Triggers ad-platform `lead_qualified` event when
 * tier crosses to Hot for the first time.
 */
import { updateLead } from "./zoho";

// ─── Project ASPs (spec 15.4) ────────────────────────────────────────────
// Used as the "expected value if lead converts to booking". Stored here
// rather than ENV so it's visible alongside the scoring formula. Update
// when projects launch.
const PROJECT_ASPS_INR: Record<string, number> = {
  "ASBL Loft": 19_400_000,
  "ASBL Spectra": 35_000_000,    // placeholder — update when finalised
  "ASBL Broadway": 25_000_000,   // placeholder
  "ASBL Landmark": 40_000_000,   // placeholder
};

const DEFAULT_ASP_INR = 19_400_000;

// ─── Tier mapping ────────────────────────────────────────────────────────
function tierForScore(score: number): "Hot" | "Warm" | "Cold" | "Disqualified" {
  if (score < 0) return "Disqualified";
  if (score >= 70) return "Hot";
  if (score >= 50) return "Warm";
  return "Cold";
}

// ─── Tier → value multiplier (spec 15.4) ────────────────────────────────
function multiplierForTier(tier: string): number {
  switch (tier) {
    case "Hot":           return 1.0;
    case "Warm":          return 0.4;
    case "Cold":          return 0.1;
    case "Disqualified":  return 0.0;
    default:              return 0.1;
  }
}

// ─── Budget matching ASP ─────────────────────────────────────────────────
const BUDGET_BUCKET_MIDPOINTS_INR: Record<string, number> = {
  under_1_5cr:    12_500_000,
  "1_5_to_2cr":   17_500_000,
  "2_to_2_5cr":   22_500_000,
  above_2_5cr:    30_000_000,
  undisclosed:    0,
};

function budgetMatchesProject(bucket: string | null | undefined, projectAsp: number): boolean {
  if (!bucket || bucket === "undisclosed") return false;
  const mid = BUDGET_BUCKET_MIDPOINTS_INR[bucket];
  if (!mid) return false;
  // Within ±35% of ASP = "matches"
  const lower = projectAsp * 0.65;
  const upper = projectAsp * 1.35;
  return mid >= lower && mid <= upper;
}

export interface LeadScoreInput {
  Intent?: string | null;
  Budget_Bucket?: string | null;
  Timeline_Bucket?: string | null;
  Configuration_Interest?: string | null;
  Workplace_Area?: string | null;
  Loan_Required?: string | null;
  Bot_Turn_Count?: number;
  F_Site_Visit_Offered?: boolean;
  F_Marked_Broker?: boolean;
  F_Opt_Out_All?: boolean;
  ASBL_Project?: string | null;
}

export interface LeadScoreResult {
  score: number;
  tier: "Hot" | "Warm" | "Cold" | "Disqualified";
  predicted_value_inr: number;
  breakdown: Record<string, number>;
}

/** Compute lead score + tier + predicted value. Pure function. */
export function computeLeadScore(lead: LeadScoreInput): LeadScoreResult {
  const breakdown: Record<string, number> = {};

  // ── Negative signals first — they short-circuit ──
  if (lead.F_Marked_Broker) {
    return {
      score: -100,
      tier: "Disqualified",
      predicted_value_inr: 0,
      breakdown: { broker_penalty: -100 },
    };
  }
  if (lead.F_Opt_Out_All) {
    return {
      score: -100,
      tier: "Disqualified",
      predicted_value_inr: 0,
      breakdown: { opt_out_penalty: -100 },
    };
  }

  let score = 0;

  // ── Disclosure points (max 50) ──
  if (lead.Intent) {
    score += 10;
    breakdown.intent_disclosed = 10;
  }
  if (lead.Budget_Bucket && lead.Budget_Bucket !== "undisclosed") {
    score += 15;
    breakdown.budget_disclosed = 15;
  }
  if (lead.Timeline_Bucket) {
    score += 10;
    breakdown.timeline_disclosed = 10;
  }
  if (lead.Configuration_Interest) {
    score += 5;
    breakdown.config_disclosed = 5;
  }
  if (lead.Workplace_Area) {
    score += 5;
    breakdown.workplace_disclosed = 5;
  }
  if (lead.Loan_Required) {
    score += 5;
    breakdown.loan_disclosed = 5;
  }

  // ── Intent multiplier ──
  const intentBonus: Record<string, number> = {
    "End Use":    10,
    "Investment": 8,
    "NRI":        12,
    "Upgrade":    8,
    "Exploring":  0,
  };
  if (lead.Intent && intentBonus[lead.Intent]) {
    score += intentBonus[lead.Intent];
    breakdown[`intent_bonus_${lead.Intent}`] = intentBonus[lead.Intent];
  }

  // ── Timeline multiplier ──
  const timelineBonus: Record<string, number> = {
    immediate:      15,
    "1_3_months":   10,
    "3_6_months":   5,
    exploring:      0,
  };
  if (lead.Timeline_Bucket && timelineBonus[lead.Timeline_Bucket]) {
    score += timelineBonus[lead.Timeline_Bucket];
    breakdown[`timeline_bonus_${lead.Timeline_Bucket}`] = timelineBonus[lead.Timeline_Bucket];
  }

  // ── Budget alignment with project ASP ──
  const projectAsp = PROJECT_ASPS_INR[lead.ASBL_Project || ""] || DEFAULT_ASP_INR;
  if (budgetMatchesProject(lead.Budget_Bucket, projectAsp)) {
    score += 15;
    breakdown.budget_aligned = 15;
  }

  // ── Engagement bonus ──
  if ((lead.Bot_Turn_Count ?? 0) >= 5) {
    score += 5;
    breakdown.high_engagement = 5;
  }
  if (lead.F_Site_Visit_Offered) {
    score += 5;
    breakdown.visit_offered = 5;
  }

  // Clamp 0–100
  const clamped = Math.min(100, Math.max(0, score));
  const tier = tierForScore(clamped);
  const predicted_value_inr = Math.round(projectAsp * multiplierForTier(tier));

  return {
    score: clamped,
    tier,
    predicted_value_inr,
    breakdown,
  };
}

/**
 * Compute + persist to Zoho. Returns whether the tier changed (caller
 * uses this to decide whether to fire `lead_qualified` ad event).
 */
export async function computeAndPersistLeadScore(
  leadId: string,
  lead: LeadScoreInput & { Lead_Tier?: string },
): Promise<{ previous_tier: string | null; new_tier: string; score: number; tier_crossed_to_hot: boolean }> {
  const result = computeLeadScore(lead);
  const previousTier = lead.Lead_Tier || null;
  const tierCrossedToHot = previousTier !== "Hot" && result.tier === "Hot";

  await updateLead(leadId, {
    Lead_Score: result.score,
    Lead_Tier: result.tier,
    Score_Last_Computed_At: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    Predicted_Value_INR: result.predicted_value_inr,
  });

  console.log(
    `[LeadScore] Lead ${leadId}: score=${result.score} tier=${previousTier || "(none)"}→${result.tier} ` +
    `predicted=₹${(result.predicted_value_inr / 100000).toFixed(1)}L ` +
    (tierCrossedToHot ? "🔥 CROSSED_TO_HOT" : ""),
  );

  return {
    previous_tier: previousTier,
    new_tier: result.tier,
    score: result.score,
    tier_crossed_to_hot: tierCrossedToHot,
  };
}

/** Look up the canonical project ASP — exported for ad platform value events. */
export function getProjectAsp(project: string | null | undefined): number {
  if (!project) return DEFAULT_ASP_INR;
  return PROJECT_ASPS_INR[project] || DEFAULT_ASP_INR;
}
