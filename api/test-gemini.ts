/**
 * Test endpoint for the Gemini reply pipeline — bypasses Periskope/Zoho.
 *
 * POST /api/test-gemini { project, message, customerName?, history? }
 *  → returns the same structured reply Gemini would produce in production,
 *    but without sending any WhatsApp message or writing to the DB.
 *
 * Use this to sanity-check KB / offer / inventory grounding after upload.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callGemini } from "./_utils/gemini_chat";
import { getProjectFacts, KNOWN_PROJECTS } from "./_utils/project_facts";
import { getInventoryForProject } from "./_utils/inventory_sheet";

async function buildProjectContext(project: string): Promise<string> {
  const parts: string[] = [];
  const facts = await getProjectFacts(project);
  if ((facts as any)?.kb_text?.trim()) {
    parts.push("## PROJECT KNOWLEDGE BASE");
    parts.push((facts as any).kb_text.trim());
  }
  if (facts?.facts_text?.trim()) {
    if (parts.length) parts.push("");
    parts.push("## OFFER DETAILS (manually curated, authoritative for offers/schemes)");
    parts.push(facts.facts_text.trim());
  }
  try {
    const inv = await getInventoryForProject(project);
    if (inv.markdown) {
      if (parts.length) parts.push("");
      parts.push("## CURRENT INVENTORY & PRICING (live from sales sheet)");
      parts.push(inv.markdown);
    }
  } catch {}
  return parts.join("\n").trim() || `No KB / inventory available for ${project} yet.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const t0 = Date.now();
  const body = (req.body || {}) as any;
  const project = String(body.project || "LOFT").toUpperCase();
  const message = String(body.message || "").trim();
  const customerName = String(body.customerName || "Test User");
  const history = String(body.history || "no prior conversation");

  if (!message) return res.status(400).json({ error: "message required" });
  if (!KNOWN_PROJECTS.includes(project as any)) {
    return res.status(400).json({ error: `Unknown project: ${project}` });
  }

  try {
    const projectContext = await buildProjectContext(project);

    const structuredMessage = [
      `<CUSTOMER>`,
      `Name: ${customerName}`,
      `Phone: 91XXXXXXXX (test)`,
      `</CUSTOMER>`,
      ``,
      `<CURRENT_PROJECT>${project}</CURRENT_PROJECT>`,
      `<LAST_PROJECT>none</LAST_PROJECT>`,
      `<DAYS_SINCE_LAST>first time</DAYS_SINCE_LAST>`,
      ``,
      `<PROJECT_CONTEXT>`,
      projectContext,
      `</PROJECT_CONTEXT>`,
      ``,
      `<CONVERSATION_HISTORY>`,
      history,
      `</CONVERSATION_HISTORY>`,
      ``,
      `<USER_MESSAGE>`,
      message,
      `</USER_MESSAGE>`,
    ].join("\n");

    const reply = await callGemini(structuredMessage, { enableGrounding: false });
    const elapsed = Date.now() - t0;

    return res.status(200).json({
      ok: true,
      project,
      message,
      elapsedMs: elapsed,
      contextSize: projectContext.length,
      gemini: reply,
    });
  } catch (err: any) {
    console.error(`[test-gemini] failed: ${err.message}`);
    return res.status(500).json({ error: err.message, elapsedMs: Date.now() - t0 });
  }
}
