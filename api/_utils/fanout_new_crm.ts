/**
 * DUAL-RUN FAN-OUT to the new Intelligent CRM.
 *
 * Purpose: during the parallel-run phase (before the full cutover repoints
 * ingestion away from this legacy `asbl-crm-api`), every lead this legacy
 * successfully processes is ALSO forwarded to the new Intelligent CRM's HTTP
 * ingest so the SAME Zoho/website/FIM/Meta/Inncircles lead shows up in BOTH
 * systems for side-by-side verification.
 *
 * This is a FAN-OUT to the new CRM's public per-source ingest endpoint — it is
 * NOT the old `ENABLE_CRM_SHADOW_WRITE` shadow-write in ingest.ts (that path
 * writes the wrong phone-based identity directly into the new DB and pollutes
 * it; keep it OFF). Here we forward the ORIGINAL raw source body and let the
 * new CRM normalise + mint identity itself, exactly as if the source had POSTed
 * to it directly.
 *
 * SAFETY CONTRACT
 *   - BEST-EFFORT: never throws, never blocks/affects the legacy ingest result.
 *     Callers `await` it only so it runs to completion inside the serverless
 *     invocation (Vercel kills fire-and-forget on handler return); it can never
 *     change the legacy Zoho write, Mongo write, or HTTP response.
 *   - GATED + INERT-BY-DEFAULT: acts ONLY when BOTH env vars are set. If either
 *     is missing it is a silent no-op, so deploying this code is safe and does
 *     nothing until the operator sets the env to START the dual-run.
 *
 * ENV VARS (set on Vercel to start the dual-run; unset to stop it):
 *   NEW_CRM_INGEST_URL     Base URL of the new Intelligent CRM API.
 *                          e.g. https://intelligent-crm-api.vercel.app
 *   NEW_CRM_INGEST_SECRET  The new CRM's INGEST_SECRET (sent as x-webhook-secret
 *                          for website|fim|inncircles; see the Meta note below).
 *
 * The fan-out POSTs the raw body to:
 *   ${NEW_CRM_INGEST_URL}/api/ingest/${source}      source ∈ website|fim|meta|inncircles
 */

const FANOUT_TIMEOUT_MS = 8000;

/**
 * Forward the ORIGINAL raw source body to the new Intelligent CRM's per-source
 * ingest endpoint. Best-effort — swallows every error.
 *
 * @param source   one of "website" | "fim" | "meta" | "inncircles" — becomes the
 *                 URL path segment /api/ingest/<source>. The new CRM normalises
 *                 the raw payload for that source itself.
 * @param rawBody  the exact raw request body the legacy handler received.
 */
export async function fanoutToNewCrm(source: string, rawBody: unknown): Promise<void> {
  const baseUrl = process.env.NEW_CRM_INGEST_URL;
  const secret = process.env.NEW_CRM_INGEST_SECRET;

  // GATED: silent no-op until BOTH env vars are configured. This is what keeps
  // the deploy inert — no traffic reaches the new CRM until the operator opts in.
  if (!baseUrl || !secret) return;

  const url = `${baseUrl.replace(/\/+$/, "")}/api/ingest/${source}`;

  // Meta note: the new CRM's /api/ingest/meta verifies an X-Hub-Signature HMAC
  // (over Meta's exact raw bytes), NOT an x-webhook-secret. We cannot re-sign
  // Meta's HMAC here (we JSON-restringify the body, so the bytes differ), so for
  // `meta` we forward WITHOUT the x-webhook-secret and it will likely be rejected
  // by the new CRM's signature check.
  // TODO(dualrun): Meta fan-out needs EITHER the new CRM to accept a shared-secret
  //   path on /api/ingest/meta, OR the dev to repoint Meta's webhook at the new
  //   CRM directly. Until then, meta is forwarded best-effort but may not land.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (source !== "meta") headers["x-webhook-secret"] = secret;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FANOUT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(rawBody),
      signal: controller.signal,
    });
    // One-line success log with the new CRM's response status.
    console.log(`[dualrun] fanout ${source} -> new CRM: ${r.status}`);
  } catch (err: any) {
    // BEST-EFFORT: never throw. One line and return so the legacy path is unaffected.
    console.error(`[dualrun] fanout ${source} failed: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}
