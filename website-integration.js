/**
 * ASBL CRM — Universal Website Lead Integration
 * -----------------------------------------------
 * Copy-paste this in ANY website — HTML, React, Next.js, Vue, WordPress, etc.
 * Just call: ASBLLeads.submit(formData)
 *
 * Endpoint: https://asbl-crm-api.vercel.app/api/ingest/website
 */

const ASBLLeads = {

  endpoint: "https://asbl-crm-api.vercel.app/api/ingest/website",

  /**
   * Get UTM params from current URL automatically
   */
  getUTMs() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source:   params.get("utm_source")   || "",
      utm_medium:   params.get("utm_medium")   || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content:  params.get("utm_content")  || "",
      utm_term:     params.get("utm_term")     || "",
    };
  },

  /**
   * Submit a lead from any form
   *
   * @param {Object} formData - Form fields
   * @param {string} formData.name          - Full name (or use first_name + last_name)
   * @param {string} formData.phone         - Phone number (any format, Indian or international)
   * @param {string} formData.email         - Email (optional)
   * @param {string} formData.project       - Project name: LOFT / SPECTRA / BROADWAY / LANDMARK / LEGACY
   * @param {string} formData.message       - Any message / comments (optional)
   * @param {string} formData.budget        - Budget preference (optional)
   * @param {string} formData.configuration - BHK / size preference (optional)
   * @param {string} formData.purpose       - Self Use / Investment (optional)
   *
   * @returns {Promise} - { success, mlid, plid, zoho_lead_id, action }
   */
  async submit(formData) {
    const utms = this.getUTMs();

    const payload = {
      // Form fields
      ...formData,

      // Auto-captured UTMs
      ...utms,

      // Auto-captured page info
      page_url:      window.location.href,
      referrer:      document.referrer || "",
    };

    try {
      const res = await fetch(this.endpoint, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("[ASBL CRM] Lead submission failed:", data);
        return { success: false, error: data.error };
      }

      console.log("[ASBL CRM] Lead submitted:", data);
      return data;

    } catch (err) {
      console.error("[ASBL CRM] Network error:", err.message);
      return { success: false, error: err.message };
    }
  },
};


// ─── Usage Examples ──────────────────────────────────────────────────────────

// Example 1: Plain HTML form
// document.getElementById("lead-form").addEventListener("submit", async (e) => {
//   e.preventDefault();
//   const result = await ASBLLeads.submit({
//     name:    document.getElementById("name").value,
//     phone:   document.getElementById("phone").value,
//     email:   document.getElementById("email").value,
//     project: "LOFT",
//     message: document.getElementById("message").value,
//   });
//   if (result.success) alert("Thank you! We'll contact you soon.");
// });


// Example 2: React / Next.js
// const handleSubmit = async (e) => {
//   e.preventDefault();
//   const result = await ASBLLeads.submit({
//     name:          formState.name,
//     phone:         formState.phone,
//     email:         formState.email,
//     project:       "LOFT",
//     configuration: formState.bhk,
//     budget:        formState.budget,
//     purpose:       formState.purpose,
//   });
//   if (result.success) setThankYou(true);
// };


// Example 3: WordPress / Contact Form 7 (via jQuery)
// document.addEventListener("wpcf7mailsent", async (event) => {
//   const inputs = event.detail.inputs;
//   const get = (name) => inputs.find(i => i.name === name)?.value || "";
//   await ASBLLeads.submit({
//     name:    get("your-name"),
//     phone:   get("your-phone"),
//     email:   get("your-email"),
//     project: "LOFT",
//     message: get("your-message"),
//   });
// });
