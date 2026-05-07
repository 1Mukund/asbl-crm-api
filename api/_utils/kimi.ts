/**
 * Kimi K2 0905 caller — narrow, structured-output requests via Routeway's
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Used as a *complement* to Gemini, not a replacement: Gemini still owns
 * the conversational reply, Kimi handles narrow extraction/dispatch tasks
 * where hallucination is the enemy and structured JSON output matters more
 * than tone or persona.
 *
 *   1. Unit-plan / floor-plan PDF dispatcher (api/_utils/unit_plan_dispatcher.ts)
 *      — picks the right size_label from a finite list using the customer
 *        message + each PDF's text_extract excerpt. Returns confidence so
 *        we can ask a clarifying question instead of sending the wrong PDF.
 *
 *   2. Factual grounder (api/_utils/factual_grounder.ts)
 *      — when customer asks for a specific spec / dimension / RERA number,
 *        Kimi reads the uploaded PDF text_extracts and returns a grounded
 *        answer that gets stuffed into Gemini's PROJECT_CONTEXT as
 *        GROUND_TRUTH so Gemini can quote it instead of guessing.
 *
 * Auth: ROUTEWAY_API_KEY env var (Routeway endpoint, OpenAI-compatible).
 * Model: ROUTEWAY_KIMI_MODEL or default "kimi-k2-0905:free" (free tier may
 * rate-limit — callers should treat Kimi failures as best-effort and fall
 * back to the existing Gemini-only path so the chatbot never becomes
 * unavailable because the secondary LLM is down).
 */

const ROUTEWAY_API_URL =
  process.env.ROUTEWAY_API_URL || "https://api.routeway.ai/v1/chat/completions";
const ROUTEWAY_API_KEY = process.env.ROUTEWAY_API_KEY || "";
const KIMI_MODEL =
  process.env.ROUTEWAY_KIMI_MODEL || "kimi-k2-0905:free";

/** True if the env var is configured — callers should branch on this and
 *  fall back to legacy logic when Kimi is unavailable, so the chatbot
 *  keeps working even if Routeway is down or the key is mis-set. */
export function kimiAvailable(): boolean {
  return !!ROUTEWAY_API_KEY;
}

export interface KimiCallOptions {
  /** Optional system prompt — keeps the call focused. */
  system?: string;
  /** User content. */
  user: string;
  /** When true, demands strict JSON object output via response_format. */
  jsonObject?: boolean;
  /** Model override for one-off experiments. */
  model?: string;
  /** Max output tokens (default 800 — narrow tasks don't need more). */
  maxTokens?: number;
  /** 0 = deterministic; 0–1. Default 0.0 — we want consistency, not creativity. */
  temperature?: number;
  /** Total timeout in ms (default 25000). */
  timeoutMs?: number;
  /** Retry once on 429 / 5xx (default true). */
  retry?: boolean;
  /** Tag for logs. */
  tag?: string;
}

export interface KimiCallResult {
  ok: boolean;
  /** Text response (parsed from message.content). Empty on failure. */
  text: string;
  /** Parsed JSON when jsonObject = true. null on parse failure. */
  json: any;
  /** finish_reason + status for diagnostics. */
  finishReason?: string;
  status?: number;
  /** Wall-clock latency for this call. */
  ms?: number;
  /** Error message when !ok. */
  error?: string;
}

/** Internal one-shot caller — used directly by retry wrapper. */
async function callOnce(opts: KimiCallOptions): Promise<KimiCallResult> {
  const body: Record<string, any> = {
    model: opts.model || KIMI_MODEL,
    messages: opts.system
      ? [
          { role: "system", content: opts.system },
          { role: "user",   content: opts.user },
        ]
      : [{ role: "user", content: opts.user }],
    max_tokens: opts.maxTokens ?? 800,
    temperature: opts.temperature ?? 0,
  };
  if (opts.jsonObject) {
    body.response_format = { type: "json_object" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25000);
  const t0 = Date.now();

  try {
    const r = await fetch(ROUTEWAY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ROUTEWAY_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;

    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      return { ok: false, text: "", json: null, status: r.status, ms, error: txt };
    }

    const data = (await r.json()) as any;
    const choice = data?.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    const finishReason: string = choice?.finish_reason ?? "unknown";

    let parsed: any = null;
    if (opts.jsonObject && content) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Tolerant: try to find a JSON object inside the content.
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch {}
        }
      }
    }

    return {
      ok: true,
      text: content,
      json: parsed,
      finishReason,
      status: r.status,
      ms,
    };
  } catch (err: any) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (err?.name === "AbortError") {
      return { ok: false, text: "", json: null, ms, error: `timeout after ${ms}ms` };
    }
    return { ok: false, text: "", json: null, ms, error: err?.message || String(err) };
  }
}

// ─── Kimi as Gemini's safety net ─────────────────────────────────────────
// When Gemini's structured-JSON call fails entirely (empty rawText / Tier-3
// parser deflection / MAX_TOKENS thinking burn on simple greetings), we
// delegate to Kimi for a quick humanlike reply so the customer doesn't get
// the generic "Let me confirm with the project team" boilerplate. Kimi sees
// the customer message + a few last conversation turns and writes a brief
// natural reply in Anandita's voice. Returns "" on failure → caller uses
// its own boilerplate.

export interface KimiQuickReplyContext {
  customerName?: string;
  project?: string | null;
  /** Last few conversation turns formatted as plain text (already sliced
   *  and labelled by the caller, e.g. "Customer: hi\nAnandita: ..."). */
  conversationSnippet?: string;
  /** When set, Kimi will lean into a "follow-up on previous question"
   *  style instead of greeting fresh. */
  hasPriorTouch?: boolean;
}

/**
 * Quick humanlike fallback reply via Kimi. Used when Gemini drops the ball.
 * Returns the reply text on success, "" on any failure (caller falls back
 * to its own boilerplate).
 */
export async function kimiQuickReply(
  customerMessage: string,
  ctx: KimiQuickReplyContext = {},
): Promise<string> {
  if (!ROUTEWAY_API_KEY) return "";

  const name = (ctx.customerName || "").trim();
  const project = (ctx.project || "").trim();

  const system =
    "You are Anandita, a Relationship Manager at ASBL (Hyderabad real estate). " +
    "The primary chatbot (Gemini) failed to produce a reply for this message. " +
    "Your job: write ONE short, natural-sounding reply (1-2 sentences max). " +
    "RULES:\n" +
    "- Address the customer as Sir/Ma'am if you don't know their gender. Use their first name only if it's clearly given.\n" +
    "- DO NOT re-introduce yourself if there's prior conversation history.\n" +
    "- DO NOT promise to send any document, price, brochure, or PDF. Only the main bot does that.\n" +
    "- DO NOT invent specifics (sizes, prices, RERA numbers, dates).\n" +
    "- For greetings (Hi/Hii/Hello/Hey), greet back warmly and ask how you can help.\n" +
    "- For unclear messages, politely ask what they need.\n" +
    "- For thank-yous, acknowledge briefly.\n" +
    "- Match the customer's language: English message → English reply, Hinglish → Hinglish.\n" +
    "- Output ONLY the reply text. No JSON, no quotes, no preface.";

  const userParts: string[] = [];
  if (name) userParts.push(`Customer name: ${name}`);
  if (project) userParts.push(`Project they enquired about: ${project}`);
  if (ctx.conversationSnippet) {
    userParts.push(`Recent conversation:\n${ctx.conversationSnippet}`);
  }
  userParts.push(`Customer's latest message: ${JSON.stringify(customerMessage)}`);
  userParts.push("Write the one-line reply now.");

  const result = await callKimi({
    system,
    user: userParts.join("\n\n"),
    jsonObject: false,
    maxTokens: 150,
    temperature: 0.4,
    timeoutMs: 18000,
    tag: "quick-reply",
  });

  if (!result.ok || !result.text) return "";
  // Strip any accidental JSON wrapping or quote chars Kimi might emit.
  let txt = result.text.trim();
  if (txt.startsWith('"') && txt.endsWith('"') && txt.length > 2) {
    txt = txt.slice(1, -1);
  }
  // If Kimi accidentally emits JSON despite jsonObject=false, try to
  // extract a `reply` field; otherwise return raw.
  if (txt.startsWith("{")) {
    try {
      const j = JSON.parse(txt);
      if (typeof j.reply === "string" && j.reply.trim()) return j.reply.trim();
    } catch {}
  }
  return txt.slice(0, 600);
}

/** Public entrypoint with one retry on 429 / 5xx (free tier hits 429 a lot). */
export async function callKimi(opts: KimiCallOptions): Promise<KimiCallResult> {
  if (!ROUTEWAY_API_KEY) {
    return { ok: false, text: "", json: null, error: "ROUTEWAY_API_KEY not configured" };
  }

  const tag = opts.tag || "kimi";
  const first = await callOnce(opts);

  if (first.ok) {
    console.log(`[Kimi:${tag}] ok in ${first.ms}ms (${first.finishReason})`);
    return first;
  }

  const retryWorthy =
    first.status === 429 || (first.status && first.status >= 500) ||
    String(first.error || "").includes("timeout");

  if (opts.retry !== false && retryWorthy) {
    console.warn(`[Kimi:${tag}] failed (${first.status || "no-status"}: ${first.error}) — retrying once`);
    // Linear backoff — 1s for free-tier throttling
    await new Promise((r) => setTimeout(r, 1000));
    const second = await callOnce(opts);
    if (second.ok) {
      console.log(`[Kimi:${tag}] ok on retry in ${second.ms}ms`);
      return second;
    }
    console.error(`[Kimi:${tag}] retry also failed (${second.status}): ${second.error}`);
    return second;
  }

  console.error(`[Kimi:${tag}] failed (${first.status}): ${first.error}`);
  return first;
}
