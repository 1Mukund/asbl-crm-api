export interface NormalizedLead {
  // Identity
  first_name: string;
  last_name: string;
  mobile: string;           // normalized phone
  email?: string;

  // Source
  lead_source: "FIM Forms" | "Website Inquiry" | "WhatsApp" | "Channel Partner";
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
}
