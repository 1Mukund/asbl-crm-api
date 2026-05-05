/**
 * Backward-compat alias for /api/relay/inhouse-call.
 *
 * The Zoho Deluge function `automation.triggerArrowheadCall` still POSTs to
 * this URL by name. Keeping the alias means no Deluge change is required
 * for the country-routed in-house migration:
 *
 *   +91 phone → in-house ASBL Voice Bot (Anandita)
 *   +1  phone → Arrowhead campaign (legacy, still active)
 *
 * The actual logic lives in ./inhouse-call so both endpoints behave
 * identically. New integrations should prefer /api/relay/inhouse-call;
 * Deluge keeps using /api/relay/arrowhead.
 */
export { default } from "./inhouse-call";
