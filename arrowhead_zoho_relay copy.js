const ZOHO_CLIENT_ID = "1000.B0AKGFC866W6ID59IQALF8D0UGIP1I";
const ZOHO_CLIENT_SECRET = "eef6a60091fb98ec3234ff1a91305aa92f3ff614e1";
const ZOHO_REFRESH_TOKEN = "1000.4a4fa18699d091348d63c6d811b7a651.44295cf8e60e2f6fd3f272ae93fb701b";
const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
const LAZYBOT_API = "https://showplace-underhand-endurable.ngrok-free.dev/api/v1";
const LAZYBOT_API_KEY = "lzb_b296d613541755478c587ed952bb79fd41b569c8dfb89b67";

// Replace with actual session IDs when 15 numbers are connected
const LAZYBOT_SESSIONS = [
  "13a646d3-476c-4c6d-bb7b-e2ccca48a3ba", // Number 1 - currently active
  "SESSION_ID_02",
  "SESSION_ID_03",
  "SESSION_ID_04",
  "SESSION_ID_05",
  "SESSION_ID_06",
  "SESSION_ID_07",
  "SESSION_ID_08",
  "SESSION_ID_09",
  "SESSION_ID_10",
  "SESSION_ID_11",
  "SESSION_ID_12",
  "SESSION_ID_13",
  "SESSION_ID_14",
  "SESSION_ID_15"
];

function getAccessToken() {
  const response = UrlFetchApp.fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "post",
    payload: {
      grant_type: "refresh_token",
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    }
  });
  return JSON.parse(response.getContentText()).access_token;
}

function findLead(token, externalJourneyId, externalCustomerId) {
  if (externalJourneyId) {
    const r = UrlFetchApp.fetch(`${ZOHO_API_BASE}/Leads/search?criteria=(Lead_Id1:equals:${externalJourneyId})&fields=id,Full_Name,Mobile,MLID,Call_History,Project`, {
      headers: { Authorization: "Zoho-oauthtoken " + token },
      muteHttpExceptions: true
    });
    const data = JSON.parse(r.getContentText());
    if (data.data && data.data.length > 0) return data.data[0];
  }
  if (externalCustomerId) {
    const r2 = UrlFetchApp.fetch(`${ZOHO_API_BASE}/Leads/search?criteria=(MLID:equals:${externalCustomerId})&fields=id,Full_Name,Mobile,MLID,Call_History,Project`, {
      headers: { Authorization: "Zoho-oauthtoken " + token },
      muteHttpExceptions: true
    });
    const data2 = JSON.parse(r2.getContentText());
    if (data2.data && data2.data.length > 0) return data2.data[0];
  }
  return null;
}

function mapOutcome(callResultSlug) {
  const slug = (callResultSlug || "").toLowerCase();
  if (slug === "pre_site") return "Pre Site";
  if (slug === "virtual_walkthrough") return "Virtual Walkthrough";
  if (slug === "share_brochure") return "Share Brochure";
  if (slug === "call_for_other_project") return "Call For Other Project";
  if (slug === "no_answer") return "Not Connected";
  if (slug === "connected" || slug === "auto_callback" || slug === "not_interested") return "Connected";
  return "Not Connected";
}

function getRoundRobinSession(mlid) {
  const activeSessions = LAZYBOT_SESSIONS.filter(s => !s.startsWith("SESSION_ID"));
  if (activeSessions.length === 0) return LAZYBOT_SESSIONS[0];
  const index = parseInt(mlid || "0") % activeSessions.length;
  return activeSessions[index];
}

function sendLazybotMessage(phone, mlid, message) {
  // Normalize phone - remove +, spaces, ensure country code
  let p = phone.replace(/\D/g, "");
  if (p.length === 10) p = "91" + p;

  const sessionId = getRoundRobinSession(mlid);

  const response = UrlFetchApp.fetch(`${LAZYBOT_API}/messages/send`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": LAZYBOT_API_KEY },
    payload: JSON.stringify({ sessionId: sessionId, phone: p, message: message }),
    muteHttpExceptions: true
  });

  const responseText = response.getContentText();
  try {
    return JSON.parse(responseText);
  } catch(e) {
    return { error: responseText.substring(0, 200) };
  }
}

function getLazybotMessage(callResultSlug, leadName, project) {
  const name = (leadName || "there").split(" ")[0];
  const proj = project || "our projects";
  const slug = (callResultSlug || "").toLowerCase();

  if (slug === "no_answer") {
    return `Hi ${name}! This is Anandita from ASBL. We tried reaching you regarding ${proj} but couldn't connect. Would you like to schedule a call at a convenient time? 😊`;
  }
  if (slug === "share_brochure") {
    return `Hi ${name}! As discussed, here's more information about ${proj}. Feel free to ask any questions — I'm here to help! 🏠`;
  }
  if (slug === "pre_site") {
    return `Hi ${name}! Great connecting with you. Looking forward to your site visit. Please let me know if you need directions or have any questions before your visit! 🏗️`;
  }
  if (slug === "virtual_walkthrough") {
    return `Hi ${name}! Excited for your virtual walkthrough of ${proj}. I'll send you the link shortly. Let me know if you have any questions! 💻`;
  }
  if (slug === "not_interested") {
    return `Hi ${name}! Thank you for your time. If you ever reconsider or have questions about ${proj}, feel free to reach out. We'd love to help you find your dream home! 🏡`;
  }
  // connected / auto_callback
  return `Hi ${name}! Great speaking with you about ${proj}. Feel free to reach out anytime if you have questions or need more information. We're here to help! 😊`;
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const externalJourneyId = payload.external_journey_id || payload.external_schedule_id || "";
    const externalCustomerId = payload.external_customer_id || "";
    const callResultSlug = payload.call_result_slug || "";
    const duration = payload.call_duration_in_secs || payload.duration || 0;
    const callId = payload.call_id || "";
    const rawDate = payload.current_datetime_ist || payload.completed_at || "";
    const completedAt = rawDate ? rawDate.replace(" ", "T") + "+05:30" : "";
    const qa = payload.question_answers || {};
    const callSummary = qa.call_summary || "";
    const budget = qa.budget || "";
    const sizePreference = qa.size_preference || "";
    const intent = qa.intent || "";

    const callStatus = (callResultSlug === "no_answer") ? "Not Connected" : "Connected";
    const callOutcome = mapOutcome(callResultSlug);
    const notes = `Summary: ${callSummary}\nBudget: ${budget}\nSize: ${sizePreference}\nIntent: ${intent}`;

    const token = getAccessToken();
    const lead = findLead(token, externalJourneyId, externalCustomerId);

    if (!lead) return ContentService.createTextOutput("Lead not found");

    const existingHistory = lead.Call_History || "";
    const newEntry = `--- ${rawDate} ---\nStatus: ${callStatus}\nOutcome: ${callOutcome}\nDuration: ${duration}s\nCall ID: ${callId}\n${notes}\n`;
    const updatedHistory = existingHistory ? existingHistory + "\n" + newEntry : newEntry;

    // Update Zoho lead
    UrlFetchApp.fetch(`${ZOHO_API_BASE}/Leads`, {
      method: "patch",
      contentType: "application/json",
      headers: { Authorization: "Zoho-oauthtoken " + token },
      payload: JSON.stringify({
        data: [{
          id: lead.id,
          Call_Status: callStatus,
          Call_Outcome: callOutcome,
          Call_Duration: duration.toString(),
          Call_Date_Time: completedAt,
          Call_Notes: notes,
          Call_History: updatedHistory
        }]
      })
    });

    // Rule 5 + 2 + 4 — Trigger Lazybot after every call
    const phone = lead.Mobile || "";
    if (phone) {
      const message = getLazybotMessage(callResultSlug, lead.Full_Name, lead.Project);
      sendLazybotMessage(phone, lead.MLID, message);

      // Update WhatsApp status in Zoho
      UrlFetchApp.fetch(`${ZOHO_API_BASE}/Leads`, {
        method: "patch",
        contentType: "application/json",
        headers: { Authorization: "Zoho-oauthtoken " + token },
        payload: JSON.stringify({
          data: [{
            id: lead.id,
            WhatsApp_Status: "Sent",
            Last_Message_Date: Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd'T'HH:mm:ssXXX")
          }]
        })
      });
    }

    return ContentService.createTextOutput("success");
  } catch (err) {
    return ContentService.createTextOutput("Error: " + err.message);
  }
}

function testLazybot() {
  const result = sendLazybotMessage("8700432466", "1003", "Hi Shaurya! Test from Apps Script 🏠");
  Logger.log(JSON.stringify(result));
}

function testCallback() {
  const e = {
    postData: {
      contents: JSON.stringify({
        external_journey_id: "1615264599690914",
        external_customer_id: "1003",
        call_result_slug: "no_answer",
        call_duration_in_secs: 0,
        call_id: "test-003",
        current_datetime_ist: "2026-04-18 01:00:00",
        question_answers: {
          call_summary: "No answer",
          budget: "",
          size_preference: "",
          intent: ""
        }
      })
    }
  };
  const result = doPost(e);
  Logger.log(result.getContent());
}
