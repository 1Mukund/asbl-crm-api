export interface NormalizedLead {
  // Identity
  first_name: string;
  last_name: string;
  mobile: string;           // normalized phone
  email?: string;

  // Source
  /** Known values below, but the Inncircles webhook now also honours a
   *  caller-supplied `source` in the payload, so any string is allowed.
   *  Whatever value is used MUST exist as a Zoho Lead_Source picklist option. */
  lead_source: "FIM Forms" | "Website Inquiry" | "WhatsApp" | "Channel Partner" | "Meta Ads" | "Inncircles M1" | "Manual Reactivation" | (string & {});
  /** Manual-reactivation only: true when this lead's project matches the
   *  reactivation sheet's latest_project for this phone (drives the Zoho
   *  purple-row flag). Undefined for non-reactivation leads. */
  reactivation_is_latest?: boolean;
  source_lead_id?: string;  // Meta lead ID, form submission ID etc.
  campaign_name?: string;
  ad_set_name?: string;
  ad_name?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  lead_received_at: string; // ISO datetime

  // Project Interest
  project?: string;
  budget?: string;
  size_preference?: string;
  floor_preference?: string;
  possession_timeline?: string;
  purchase_purpose?: string;
  lead_comments?: string;

  // Web Tracking
  first_page_visited?: string;
  last_page_visited?: string;
  total_page_views?: number;
  time_spent_minutes?: number;
  referrer_url?: string;

  // Per-section engagement time (from Inncircles; typically seconds).
  section_timespent?: {
    home?: number;
    plans?: number;
    price?: number;
    location?: number;
    specification?: number;
    amenities?: number;
    media?: number;
  };
}
