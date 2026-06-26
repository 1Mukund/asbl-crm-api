# ASBL WhatsApp/Periskope Chatbot — Full Audit Report

_Generated from a multi-agent adversarial audit (8 subsystems, 108 agents, 113 unique confirmed bugs). Synthesized 2026-06-26._

## How to read this
The bot's problems are NOT 113 independent bugs. They cluster into ~7 architectural holes. Fix the holes and most bugs vanish. The clusters map 1:1 to the live issues you reported (R1-R7).

## 1. Reported-issue root causes (R1-R7)

### R1 — price_sheet single row -> bot asks 'which one: Spectra' (1 option)
**Root cause:** Missing `if (rows.length === 1) chosen = [rows[0]]` guard before the multi-slot scoring branch; the `top > 0` requirement also discards the only viable candidate when no hint is present.
`api/_utils/doc_send_tool.ts:202-227`
_(9 related bugs)_

### R2 — 'Both'/tower-name answer ignored, clarification loops forever
**Root cause:** Format contract drift: the history formatter uses role labels 'you'/'customer' with a timestamp prefix, but extractLastBotTurn expects un-prefixed 'Anandita:'/'Bot:' lines. The two were never reconciled.
`api/relay/periskope-webhook.ts:710-721`
_(13 related bugs)_

### R3 — English message -> Hindi/Hinglish reply (off-topic redirect)
**Root cause:** The few-shot OFF_TOPIC examples were written only in Hinglish and were never made language-conditional; they out-weight RULE 6 for the redirect path.
`api/_utils/gemini_chat.ts:411-414`
_(13 related bugs)_

### R4 — every reply ends with a site-visit CTA (pushy)
**Root cause:** CTA cadence requires turn-to-turn state (did_last_reply_have_cta) that is not stored on user_profile nor passed to Gemini, and no post-processor de-CTAs alternate replies. Prompt + sample JSON actively bias toward always-CTA.
`api/_utils/gemini_chat.ts:66`
_(8 related bugs)_

### R5 — send-doc-test admin endpoint 401 on valid secret
**Root cause:** Adding curl/secret-authenticatable admin actions to the session-only DASHBOARD_ACTIONS allow-list. The top gate has no awareness of the per-handler secret fallback, so for these specific actions session-auth is required and short-circuits before the secret check. The two auth layers were designed to be mutually exclusive (DASHBOARD_ACTIONS = session-gated; everything else = self-secret-gated) but these six actions were wrongly placed in both worlds.
`api/chat-history.ts:1545-1605`
_(6 related bugs)_

### R6 — doc send unreliable / double / silent-fail end to end
**Root cause:** The preflight unified-tool block was added in front of the older strict block but the older block's guard was never removed; the two paths are mutually exclusive and the second is unreachable.
`api/relay/periskope-webhook.ts:1382-1453`
_(20 related bugs)_

### R7 — bot sounds robotic, loses context across turns
**Root cause:** History is text-only with no structured per-turn state object threaded across turns; the intent/doc metadata that IS stored on message rows is dropped from the formatted context, and the relay-side reconstruction helpers are non-functional.
`api/_utils/conversation_context.ts:39-48`
_(20 related bugs)_

## 2. CRITICAL & HIGH bugs (deduped)

### doc-send (9)
- **[CRITICAL]** Single-row multi-slot doc type (price_sheet with 1 row) is wrongly returned as AMBIGUOUS instead of SEND
  - `api/_utils/doc_send_tool.ts:202-227`
  - Missing `if (rows.length === 1) chosen = [rows[0]]` guard before the multi-slot scoring branch; the `top > 0` requirement also discards the only viable candidate when no hint is present.
  - maps to R1
- **[CRITICAL]** sendDocumentTool treats a single-row multi-slot doc_type as AMBIGUOUS instead of sending it
  - `api/_utils/doc_send_tool.ts:199-228`
  - sendDocumentTool's multi-slot branch requires top>0 to send; with no hint every row scores 0 so even a single row is declared ambiguous. No `rows.length===1 → send` short-circuit and no applies_to_all handling, unlike getDocumentStrict.
  - maps to R1
- **[CRITICAL]** Webhook pre-flight uses sendDocumentTool which ignores getDocumentStrict's single-row + applies_to_all logic
  - `api/relay/periskope-webhook.ts:1362-1406`
  - Two parallel doc-resolution engines with divergent ambiguity rules; the pre-flight short-circuits the stricter, correct engine. The AMBIGUOUS-with-one-option text is also not guarded against options.length===1 (line 1397 just inlines the si
  - maps to R1
- **[CRITICAL]** Single-row multi-slot doc (price_sheet) returns AMBIGUOUS instead of SEND when no hint is given
  - `api/_utils/doc_send_tool.ts:202-227`
  - scoreRow only awards points for matched hints; with no hint every row scores 0, and the AMBIGUOUS branch fires regardless of row count. Missing `if (rows.length === 1) chosen=[rows[0]]` (and/or treating a single available variant as unambig
  - maps to R1
- **[HIGH]** Single-row multi-slot doc (price_sheet with 1 row) wrongly treated as AMBIGUOUS
  - `api/_utils/doc_send_tool.ts:202-227`
  - No early branch: when rows.length===1 (or all rows score 0 but there is only one), the tool should SEND rather than fall into the no-hint AMBIGUOUS path. The scoring/winners logic only sends when a positive-scoring unique winner exists, whi
  - maps to R1
- **[HIGH]** 'Both'/'all' answer to a 2-option clarification does not trigger SEND-ALL
  - `api/relay/periskope-webhook.ts:1354-1360`
  - SEND-ALL regex is context-free; it ignores that the previous bot turn was a clarification offering a finite option set, where a quantifier alone unambiguously means 'all of those'.
  - maps to R2
- **[HIGH]** Multi-slot doc type with exactly one row is treated as AMBIGUOUS instead of auto-sent
  - `api/_utils/doc_send_tool.ts:199-228`
  - The decision logic keys off score>0 rather than candidate count. A lone row should be unconditionally sent (mirrors the applies_to_all short-circuit in document_dispatcher.getDocumentStrict at lines 112-114, which doc_send_tool does not rep
  - maps to R1
- **[HIGH]** buildClarificationMessage renders a 'which one?' prompt even for a single option
  - `api/_utils/unit_plan_dispatcher.ts:295-301`
  - No single-option special-case; the function assumes it's only ever called with 2+ ambiguous options.
  - maps to R1
- **[HIGH]** Preflight doc tool and downstream strict-lookup can both send the same doc; preflightHandled only set on definitive outcomes
  - `api/relay/periskope-webhook.ts:1342-1423 (preflight) and 1453-1847 (downstream strict)`
  - Two independent send pipelines (preflight tool + downstream strict/legacy) guarded only by a single boolean that isn't set on every early-exit path; sending and logging happen in multiple layers with no idempotency key per (phone,url,turn).
  - maps to R6

### language (7)
- **[HIGH]** OFF_TOPIC few-shot examples are all Hinglish, overriding RULE 6 language matching
  - `api/_utils/gemini_chat.ts:411-414`
  - The few-shot OFF_TOPIC examples were written only in Hinglish and were never made language-conditional; they out-weight RULE 6 for the redirect path.
  - maps to R3
- **[HIGH]** OFF_TOPIC redirect examples are 100% Hinglish, overriding RULE 6 language matching on the redirect path
  - `api/_utils/gemini_chat.ts:405-414`
  - OFF_TOPIC few-shot examples are mono-lingual (Hinglish) and outweigh the abstract RULE 6 instruction; no English/Telugu OFF_TOPIC exemplar exists to anchor language mirroring on the redirect path.
  - maps to R3
- **[HIGH]** Every off-topic/redirect EXAMPLE in the prompt is Hinglish — trains Gemini to reply Hinglish to English
  - `api/_utils/gemini_chat.ts:143-147, 159-163, 404-414`
  - Few-shot redirect examples in RULE 3 and the OFF-TOPIC HANDLING section are written in Hinglish for English inputs, directly contradicting RULE 6 (language matching). Examples outweigh the abstract rule.
  - maps to R3
- **[HIGH]** All cold + ghost follow-up templates are hardcoded Hinglish, sent to English-only leads
  - `api/_utils/prd_orchestrator.ts:486-559`
  - Template banks are static string arrays with embedded Hinglish; no `language` field is read from the lead or from Last_Customer_Response, and no language param is passed into buildFollowupMessage/buildReengagementMessage. The cron never ins
  - maps to R3
- **[HIGH]** OFF-TOPIC redirect few-shots are all Hinglish/Devanagari, overriding RULE 6 language matching
  - `api/_utils/gemini_chat.ts:141-147`
  - Few-shot examples in the off-topic section are monolingually Hinglish and contradict RULE 6. There is no language-conditioned example set (English-in => English redirect). Prompt-internal contradiction biases the model toward Hinglish on th
  - maps to R3
- **[HIGH]** preferred_language is captured only on explicit switch, never persisted from normal turns, and never used to override per-turn detection
  - `api/_utils/gemini_chat.ts:539; api/_utils/user_profile.ts:107-118,425-454; api/relay/periskope-webhook.ts:1239-1252`
  - Language is treated as a per-turn LLM decision; the persisted preferred_language field is write-gated to explicit switches and is never read back as an enforcement constraint on the outgoing reply.
  - maps to R3
- **[HIGH]** System prompt's OFF_TOPIC / RULE 3 redirect examples are almost all Hinglish, biasing redirects to Hindi regardless of input language
  - `api/_utils/gemini_chat.ts:138-167 (RULE 3) and 404-419 (OFF-TOPIC HANDLING)`
  - Few-shot example imbalance: the off-topic redirect exemplars are nearly all Hinglish, so on that branch the model copies the language of the examples instead of the customer's input.
  - maps to R3

### persona-cta (5)
- **[HIGH]** CTA 'every other reply' cap is prompt-only with no state tracking; bot ends nearly every reply with a CTA
  - `api/_utils/gemini_chat.ts:66`
  - CTA cadence requires turn-to-turn state (did_last_reply_have_cta) that is not stored on user_profile nor passed to Gemini, and no post-processor de-CTAs alternate replies. Prompt + sample JSON actively bias toward always-CTA.
  - maps to R4
- **[HIGH]** CTA 'every other reply' cap is unenforceable — no state tracks whether the previous reply contained a CTA, and the rest of the prompt mandates a CTA every turn
  - `api/_utils/gemini_chat.ts:66`
  - The cap requires cross-turn state (did the previous reply contain a CTA?) that is never computed, stored, or fed back into the prompt; combined with contradictory 'CTA every reply' instructions elsewhere in the same prompt.
  - maps to R4
- **[HIGH]** CTA cap (rule 3: at most every other reply) is prompt-only and contradicted by many CTA-ending examples; no server enforcement
  - `api/_utils/gemini_chat.ts:66,289,359-371`
  - Contradictory prompt (rule 3 cap vs 'end MOST replies with a CTA' on lines 359-363) plus zero server-side CTA-frequency enforcement; no per-conversation CTA counter.
  - maps to R4
- **[HIGH]** CTA-discipline ('every other reply') is prompt-only with no code enforcement and is contradicted by SOFT-CLOSE rule
  - `api/_utils/gemini_chat.ts:66, 239, 358-364`
  - Conflicting instructions (baseline cap vs persona 'every reply'/'most replies' CTA), no state fed to the model about recent CTA usage, and no deterministic CTA throttle in code.
  - maps to R4
- **[HIGH]** CTA cadence ('every other reply') has no state and is unenforceable; sanitizer doesn't strip CTAs
  - `api/_utils/gemini_chat.ts:66 (HARD_BASELINE rule 3), 358-364 (SOFT CLOSE persona), 239 (SEQUENTIAL COMMITMENT); api/_utils/sanitizer.ts:8-143`
  - Conflicting prompt instructions (persona 'end most replies with CTA' vs baseline 'every other reply') plus zero state/post-processing to track or trim CTA frequency.
  - maps to R4

### context-state (11)
- **[CRITICAL]** Pending-doc fast-path never fires — extractLastBotTurn cannot parse 'you:' history format
  - `api/relay/periskope-webhook.ts:710-721`
  - Format contract drift: the history formatter uses role labels 'you'/'customer' with a timestamp prefix, but extractLastBotTurn expects un-prefixed 'Anandita:'/'Bot:' lines. The two were never reconciled.
  - maps to R2
- **[CRITICAL]** No persisted pending-doc clarification state across turns
  - `api/relay/periskope-webhook.ts:985-1037`
  - The disambiguation answer is never consumed because there is no durable pending-doc state and the send-all/'Both' path is not wired. 'Both' also fails the SEND-ALL detector (ALL_QUANTIFIER needs a VARIANT_NOUN like 'towers'/'sizes' alongsid
  - maps to R2
- **[CRITICAL]** No persisted pending-doc-clarification state; the only carry-over reads outbound history with a regex that can never match
  - `api/relay/periskope-webhook.ts:710-721`
  - Two compounding faults: (1) extractLastBotTurn role-label/prefix regex is incompatible with conversation_context.ts output format, making the only state-carry path dead; (2) no durable pending_clarification field is persisted across turns, 
  - maps to R2
- **[CRITICAL]** No persisted 'pending doc clarification' state — disambiguation answer is reconstructed from history and lost
  - `api/relay/periskope-webhook.ts:995-1037`
  - Doc disambiguation has no server-side pending-question record keyed to phone+doc_type+options; resumption relies on brittle text heuristics that don't cover 'Both'/'all' and always assume unit_plan.
  - maps to R2
- **[CRITICAL]** No persisted pending-clarification ('we asked which tower') state across turns
  - `api/_utils/user_profile.ts:57-83 (UserProfile schema) and api/_utils/whatsapp_messages.ts (no pending field)`
  - Design omission: cross-turn conversational state was never modeled; the codebase relies on re-reading the formatted history string, and the one parser that does so is broken.
  - maps to R2
- **[HIGH]** All three clarification emitters (preflight, strict-not-found, ambiguous) are stateless and identically loopable
  - `api/relay/periskope-webhook.ts:1660-1809`
  - Clarification is treated as a terminal reply, not as a state transition; no pending-doc record is written by any of the three emitters.
  - maps to R2
- **[HIGH]** Conversation history is fed to Gemini as plain timestamped text with no structured state (pending question, last CTA, last doc); all cross-turn 'memory' depends on the model re-reading raw lines
  - `api/_utils/conversation_context.ts:39-48`
  - History is text-only with no structured per-turn state object threaded across turns; the intent/doc metadata that IS stored on message rows is dropped from the formatted context, and the relay-side reconstruction helpers are non-functional.
  - maps to R7
- **[HIGH]** Pending-doc fast-path is permanently dead due to history-format mismatch (extractLastBotTurn)
  - `api/relay/periskope-webhook.ts:996-1037`
  - extractLastBotTurn regex/anchor is incompatible with getConversationContext's output format ('you:' role + leading '[date time]' prefix).
  - maps to R2
- **[HIGH]** Prompt has no 'pending doc clarification' state; 'Both' answer cannot be consumed -> verbatim re-ask loop
  - `api/_utils/gemini_chat.ts:466-497`
  - No pending-clarification state is threaded into the prompt, and the webhook's only carry-over (fast-path) is unit_plan-only and rejects non-size answers like 'Both'/'all'/'saare'.
  - maps to R2
- **[HIGH]** Disambiguation answer ('Both' / tower / size) is never consumed for price_sheet/floor_plan — clarification loops forever
  - `api/relay/periskope-webhook.ts:994-1037`
  - No cross-turn pending-clarification state machine; the only carry-over (fast-path) is hardcoded to unit_plan and to size-shaped answers. 'Both'/'all'/'dono' are not interpreted as send_all_variants. The disambiguation context is lost betwee
  - maps to R2
- **[HIGH]** Disambiguation answer ('Both'/tower/size) never consumed for price_sheet/floor_plan — clarification loops forever
  - `api/relay/periskope-webhook.ts:994`
  - No cross-turn pending-clarification state machine; the only carry-over (fast-path) is hardcoded to unit_plan and to size-shaped answers. 'Both'/'all'/'dono' are not interpreted as send_all_variants.
  - maps to R2

### auth (5)
- **[CRITICAL]** Top session gate returns 401 before secret-checking handlers run for send-doc-test and 4 sibling actions
  - `api/chat-history.ts:1545-1605`
  - Adding curl/secret-authenticatable admin actions to the session-only DASHBOARD_ACTIONS allow-list. The top gate has no awareness of the per-handler secret fallback, so for these specific actions session-auth is required and short-circuits b
  - maps to R5
- **[HIGH]** send-doc-test 401s for valid secret — upstream session gate short-circuits before secret check
  - `api/chat-history.ts:1554`
  - Ordering/membership bug: actions that support secret-based auth (send-doc-test, audit-project-docs) must be excluded from the session-only DASHBOARD_ACTIONS gate, or the gate must allow a valid secret to pass. site-visit-leads-csv and mark-
  - maps to R5
- **[HIGH]** send-doc-test admin endpoint returns 401 for valid ?secret= because dashboard session gate runs first
  - `api/chat-history.ts:1545-1605`
  - send-doc-test (and audit-project-docs, export-all-kb) are simultaneously in the session-gated DASHBOARD_ACTIONS set AND have their own secret-based gate downstream; the session gate fires first and short-circuits the secret path.
  - maps to R5
- **[HIGH]** send-doc-test (and audit-project-docs) 401 because the dashboard session gate runs before the handler's secret check
  - `api/chat-history.ts:1545-1604,6762-6768`
  - Action is in the session-only DASHBOARD_ACTIONS allowlist, but its handler was written to also accept the shared secret. The two auth layers disagree; the gate (session-only) wins and blocks valid secrets.
  - maps to R5
- **[HIGH]** Dashboard auth gate returns 401 before send-doc-test's own secret check runs
  - `api/chat-history.ts:1554`
  - send-doc-test (and the other secret-OR-session actions) were added to DASHBOARD_ACTIONS, which forces session-cookie auth at the early gate and short-circuits their intended dual session-or-secret auth. The early gate has no secret fallback
  - maps to R5

### data-schema (1)
- **[HIGH]** upload-doc path never writes unit_size_sft/facing/tower/applies_to_all, so strict lookup can't match those rows
  - `api/chat-history.ts:2148-2158`
  - upload-doc predates the v5 strict schema and was never updated to derive/persist unit_size_sft/facing/tower (or applies_to_all) from size_label/body; the bot reads strict columns that this writer leaves null.
  - maps to R6

### storage-race (2)
- **[HIGH]** recordSenderSuccess only called on 2 of 5 send paths — dead-sender state never clears on the others
  - `api/_utils/ops_collections.ts:125`
  - The success-resets-failure-counter contract is implemented per-path and was only wired into 2 of the 5 hand-rolled pool-fallback loops; the other 3 were copy-pasted without the recordSenderSuccess call.
- **[HIGH]** getNextSequence startAt fix-up does a destructive $set that can reset the counter / mint duplicate MLIDs
  - `api/_utils/mongo.ts:174`
  - startAt is implemented as a read-then-write $set after the atomic $inc instead of being seeded once via an atomic seed/$max, breaking the atomicity guarantee the function claims.

### correctness (7)
- **[CRITICAL]** Multi-slot doc with exactly ONE row is treated as AMBIGUOUS instead of SEND
  - `api/_utils/doc_send_tool.ts:202-227`
  - AMBIGUOUS branch lacks a rows.length===1 (and an applies_to_all) early-send case; the winner-selection guard requires top>0 which is impossible when no hint is supplied.
  - maps to R1
- **[HIGH]** Entire v5 strict flow (validateDocSend, applies_to_all, legacy single-slot fallback) is dead — gated behind !preflightHandled which is always false
  - `api/relay/periskope-webhook.ts:1382-1453`
  - The preflight unified-tool block was added in front of the older strict block but the older block's guard was never removed; the two paths are mutually exclusive and the second is unreachable.
  - maps to R6
- **[HIGH]** Pending-doc fast-path always dispatches as unit_plan, ignoring the actual clarified doc_type
  - `api/relay/periskope-webhook.ts:1006`
  - The fast-path was written only for unit_plan and never parameterised on the doc_type that was actually being disambiguated (which isn't persisted anywhere).
  - maps to R2
- **[HIGH]** sendDocumentTool ignores applies_to_all; single 'covers all configs' doc gets stuck on AMBIGUOUS
  - `api/_utils/doc_send_tool.ts:159-228`
  - applies_to_all handling lives only in the now-dead getDocumentStrict path, not in the unified tool that replaced it.
  - maps to R6
- **[HIGH]** VALID_INTENTS array omits OFF_TOPIC and IDENTITY — both silently downgraded to GENERAL
  - `api/_utils/gemini_chat.ts:596-601`
  - VALID_INTENTS was not updated when OFF_TOPIC and IDENTITY were added to the prompt; the '19' count is also stale (prompt lists 21).
  - maps to R3
- **[HIGH]** Chatbot window expiry marks lead Not Interested immediately, ignoring Option Y (both channels must exhaust)
  - `api/cron/followup.ts:421-425,456-460`
  - voiceExhausted stub returns false but is never checked at the close site; onSsTreeExhausted is called unconditionally on window expiry. The Option-Y dual-channel guard documented in the header was never wired in after the v3 calling rewrite
- **[HIGH]** Inbound WhatsApp reply has no dead-sender pool fallback — reply silently fails when the sticky sender is offline
  - `api/relay/periskope-webhook.ts:844`
  - Deliberate 'never switch sender mid-conversation' rule was implemented as 'fail the send' instead of 'fall back to a pool member and re-stick', so a dead sticky sender = total inbound-reply blackout for that customer.
  - maps to R7

## 3. MEDIUM & LOW (compact)

### MEDIUM (38)
- Language detection delegated entirely to Gemini; no deterministic detector or hard guard — `api/relay/periskope-webhook.ts:1150-1162`
- Doc-send ack reuses Gemini's CTA-laden reply instead of a clean confirmation — `api/relay/periskope-webhook.ts:1382-1390`
- audit-project-docs (and other secret endpoints in DASHBOARD_ACTIONS) also 401 for curl des — `api/chat-history.ts:1551-1553`
- sendDocumentTool returns ERROR when all sends fail but reply path can still mislead — `api/_utils/doc_send_tool.ts:279-285`
- PRE-FLIGHT doc tool and downstream strict/legacy block both run for the same request, gate — `api/relay/periskope-webhook.ts:1453`
- Outbound reply saved to history before Periskope send; on send failure history shows a mes — `api/relay/periskope-webhook.ts:1428-1437`
- Gemini project override happens AFTER PROJECT_CONTEXT and doc lookups were built for the o — `api/relay/periskope-webhook.ts:1231-1237`
- mergeProfile uses $set without upsert; a missing profile row silently drops all extracted  — `api/_utils/user_profile.ts:281-289`
- sendDocViaPeriskope network/payload failure on the sticky sender does not fall through the — `api/_utils/document_dispatcher.ts:355-374`
- Scoring tie on a strong hint yields AMBIGUOUS instead of preferring an exact match — `api/_utils/doc_send_tool.ts:207-227`
- validateDocSend can block legitimate sends when reply text echoes a size from earlier cont — `api/_utils/doc_validator.ts:54-132`
- Hardcoded doc-flow replies are Hinglish regardless of customer language — `api/relay/periskope-webhook.ts:1415,1419,1529`
- Text ack 'sending now' is saved+sent BEFORE the PDF send attempt, so failures leave a fals — `api/relay/periskope-webhook.ts:1382-1438`
- Sanitizer performs no language detection/enforcement; RULE 6 is prompt-only — `api/_utils/sanitizer.ts:96-143`
- Pre-flight doc send bypasses validateDocSend; downstream strict path enforces it — inconsi — `api/relay/periskope-webhook.ts:1362-1390`
- sendDocumentTool.scoreRow fuzzy matching can pick the wrong variant (partial size_label co — `api/_utils/doc_send_tool.ts:119-155`
- Kimi fallback (kimiFullClassifyAndReply / kimiQuickReply) is dead code — webhook never cal — `api/_utils/kimi.ts:214-261, 288-346`
- Recovery path discards a valid doc_to_send when its reply happens to start like a Tier-3 p — `api/_utils/gemini_chat.ts:696-701`
- Tier-2 regex parser recovery always nulls doc_to_send/docMeta even when present in raw tex — `api/_utils/gemini_chat.ts:946-965`
- System prompt duplicates every major rule 2-3x with divergent wording (off-topic, docs, cr — `api/_utils/gemini_chat.ts:59-74, 138-167, 169-179, 366-419, `
- Residual 'English default' instructions contradict RULE 6 language-matching — `api/_utils/gemini_chat.ts:428, 541`
- Tier-3 deflection bank and recovery deflection are English-only, breaking language match o — `api/_utils/gemini_chat.ts:616-622, 644`
- Counter increment uses stale in-memory lead; cold+ghost increments not reflected within sa — `api/_utils/prd_cadence.ts:81-91`
- Cold vs ghost branch decided solely by Mongo whatsapp_messages history; missing/lost histo — `api/cron/followup.ts:399-461`
- All-senders-dead: counter not bumped (good) but cold/ghost window expiry still closes lead — `api/cron/followup.ts:402-461`
- Ghost branch dueByInterval/realDueByInterval double-computed; anchors only on bot outbound — `api/cron/followup.ts:435-445`
- Cron handler auth check is fully bypassed for any GET request — `api/cron/followup.ts:528-531`
- CTA cap (every-other-reply) is prompt-only with no programmatic enforcement and contradict — `api/_utils/gemini_chat.ts:66`
- Bulk/send-all partial failures are logged but not surfaced; per-row failures swallowed — `api/_utils/doc_send_tool.ts:235-285`
- Non-dead Periskope error (e.g. 400/5xx) throws without trying remaining senders, can drop  — `api/_utils/document_dispatcher.ts:351-376`
- Bulk/send-all partial failures not surfaced on preflight SEND path; per-row failures swall — `api/_utils/doc_send_tool.ts:280`
- Non-dead Periskope error (400/5xx) throws without trying remaining senders, dropping a rec — `api/_utils/document_dispatcher.ts:369`
- hasHistory greeting-strip detection depends on the literal 'you:' token, fragile and forma — `api/relay/periskope-webhook.ts:1306-1322`
- stripReintroduction can corrupt valid replies: capitalizes Devanagari/Telugu first char in — `api/_utils/sanitizer.ts:74-93`
- sendDocumentTool reports outcome=SEND when some variants failed, hiding partial doc-send f — `api/_utils/doc_send_tool.ts:279-285`
- Fast-path sends an 'sending now' ack before the PDF dispatch, which can then fail silently — `api/relay/periskope-webhook.ts:1014-1027`
- dead_senders has no Mongo TTL index; consecutive_failures counter is permanently sticky — `api/_utils/ops_collections.ts:73`
- consecutive_failures threshold (6) for the 'stuck sender' alert is effectively unreachable — `api/_utils/ops_collections.ts:111`

### LOW (28)
- Fast-path writes Last_Intent='Document Sent' but Zoho picklist only accepts the 6 mapped v — `api/relay/periskope-webhook.ts:1045`
- stripReintroduction can delete legitimate content when greeting detection disagrees with G — `api/relay/periskope-webhook.ts:1306-1322`
- Sequential advanceFunnel/setActiveProject/mergeProfile each do independent updateOne write — `api/_utils/user_profile.ts:337-357`
- stripReintroduction bare 'Hi <Name>,' pattern can clip a legitimate non-greeting opener on — `api/_utils/sanitizer.ts:74-80`
- preferred_language is stored but never used to stabilize replies; language is re-detected  — `api/_utils/gemini_chat.ts:539`
- sendDocumentTool returns outcome=ERROR with sent_count 0 swallowed into a generic deflecti — `api/_utils/doc_send_tool.ts:279-285`
- Sanitizer strips 'as discussed' from bot text replies, mangling natural doc-send confirmat — `api/_utils/sanitizer.ts:26`
- resolveProject locks onto the most-recent tagged project from EITHER direction, which can  — `api/_utils/project_detection.ts:48-60,99-121`
- Inventory 5-min cache is a module-global; serverless cold/warm instances serve divergent s — `api/_utils/inventory_sheet.ts:32-33,109-111,288-293`
- detectMultiProjectIntent matches naked substrings ('in all','compare','each project') caus — `api/_utils/project_detection.ts:66-87`
- Two different label-listing functions feed clarification messages, producing inconsistent  — `api/_utils/project_documents.ts:163-187,api/_utils/document_`
- Kimi full-replacement and recovery accept intents the parser would reject; intent normaliz — `api/_utils/kimi.ts:159-198, 241; api/_utils/gemini_chat.ts:5`
- Factual grounder injects English GROUND_TRUTH with a 'quote verbatim' directive that can o — `api/_utils/factual_grounder.ts:121-126, 186-193`
- isClarificationAsk matches generic CTA phrasing ('may I send', 'which would you like'), ca — `api/relay/periskope-webhook.ts:726-739`
- Initial greeting and several follow-up templates contain em-dashes / robotic stock phrasin — `api/_utils/prd_orchestrator.ts:486-509`
- fireChatbotMessage has no rate pacing; cron can fire chatbot tick AND call tick for same l — `api/cron/followup.ts:345-505`
- Pre-Site-Visit reminders are hardcoded English while follow-ups are Hinglish — inconsisten — `api/cron/followup.ts:705-728`
- bot_enabled kill-switch phone normalization may not match lead phone normalization — `api/cron/followup.ts:263-288`
- 7-day-silence skip exits before scanned++ and never closes the lead, leaving it permanentl — `api/cron/followup.ts:294-304`
- Dashboard HTML view handlers can throw inside render before any response on the hot path — `api/chat-history.ts:1643-1667`
- 15 serverless functions deployed — over the documented Vercel Hobby 12-function cap — `api/relay/arrowhead.ts:1`
- Always-first auth-gate block has no try/catch — a DB/import failure becomes an opaque 500  — `api/chat-history.ts:1536`
- 30-day history hard-capped at 80 messages via slice(-limit); older clarifications/commitme — `api/_utils/conversation_context.ts:14,27 and api/_utils/what`
- Project override path can thrash current_project/last_project on a single turn — `api/relay/periskope-webhook.ts:1147,1232-1237 and api/_utils`
- Round-robin sender_idx counter shares the same _counters collection/keyspace as MLID/PLID  — `api/_utils/ops_collections.ts:164`
- stuck_sends and psv_reminders collections used via raw string, bypassing the COL registry — `api/_utils/prd_orchestrator.ts:187`
- markSenderDead alert read-after-write is not atomic — alert can double-fire or be missed u — `api/_utils/ops_collections.ts:109`
- getClient health check relies on private topology.isDestroyed() and silently returns a pos — `api/_utils/mongo.ts:108`
