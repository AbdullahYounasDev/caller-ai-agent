/**
 * THE CAPABILITY CATALOG — the single source of truth for what the agent can do
 * for a business, beyond answering questions from its knowledge base.
 *
 * Three consumers read this one list, which is the whole point of it existing:
 *   1. lib/agent/prompt.js  — turns enabled capabilities into system-prompt text
 *   2. /api/agent-config/catalog — the partner's dashboard renders toggles from it
 *   3. (Phase 4) the tool registry — `toolName` becomes a real function declaration
 *
 * Adding a capability = adding an object here. No migration, no dashboard change,
 * no prompt edit. That is why tenant state is JSON in agent_configs while the
 * catalog itself lives in code.
 *
 * FIELDS
 *   id           stable key — also the key used in agent_configs.capabilities. Never rename.
 *   label/description  shown in the partner's dashboard. User-facing → will need i18n (Phase 1c).
 *   channels     channels this capability can PHYSICALLY work on. A tenant may narrow
 *                this further, but never widen it. `document_upload` on a voice call
 *                is nonsense, and this is where that's enforced.
 *   requiresTool true = it must actually DO something in an external system, so it
 *                cannot work until tool-calling lands (Phase 4). See TOOL_EXECUTION_AVAILABLE
 *                in prompt.js — until then the agent gathers details and promises
 *                follow-up rather than claiming the deed is done.
 *   toolName     the function name Phase 4 will register with Gemini. Null when conversational.
 *   params       default params + their shape. Tenant overrides merge OVER these.
 *   prompt       ({ params, channel }) => string — the instruction injected into the
 *                system prompt when enabled. Keep it imperative and specific; this is
 *                the actual behavior, not documentation.
 */

export const CAPABILITIES = [
  {
    id: "collect_contact_info",
    label: "Collect contact details",
    description:
      "Gather the caller's name, phone, email and reason for contact, then confirm them back.",
    channels: ["widget", "whatsapp", "voice"],
    // Conversational: the transcript in `messages` IS the captured record today.
    // Phase 4 upgrades this to a structured agent_actions row.
    requiresTool: false,
    toolName: null,
    params: {
      fields: ["name", "phone", "email", "reason"],
      required: ["name", "phone"],
    },
    prompt: ({ params, channel }) => {
      const fields = params.fields.join(", ");
      const required = params.required.join(", ");
      return [
        `COLLECT CONTACT DETAILS: over the course of the conversation, naturally gather: ${fields}.`,
        `You must not end the conversation without at least: ${required}.`,
        "Ask for at most one or two details at a time — never interrogate with a list.",
        channel === "voice"
          ? "On a call, read phone numbers and email addresses back digit by digit / letter by letter to confirm you heard them correctly."
          : "Repeat the details back once to confirm them before moving on.",
      ].join(" ");
    },
  },

  {
    id: "book_appointment",
    label: "Book appointments",
    description:
      "Take a booking for a slot — service, date, time and the customer's details.",
    channels: ["widget", "whatsapp", "voice"],
    requiresTool: true,
    toolName: "book_appointment",
    params: {
      services: [], // e.g. ["Consultation", "Follow-up"] — empty = any service
      slotMinutes: 30,
      maxDaysAhead: 30,
    },
    prompt: ({ params }) => {
      const services = params.services?.length
        ? `Bookable services: ${params.services.join(", ")}.`
        : "Ask what the appointment is for.";
      return [
        "BOOK APPOINTMENTS: you can take bookings.",
        services,
        `Appointments are ${params.slotMinutes} minutes and can be booked up to ${params.maxDaysAhead} days ahead.`,
        "Collect: service, preferred date and time, name, and a phone number.",
        "Only offer times inside the business hours given above.",
      ].join(" ");
    },
  },

  {
    id: "take_message",
    label: "Take a message",
    description:
      "Record a message for the team when nobody is available or the request needs a human.",
    channels: ["widget", "whatsapp", "voice"],
    requiresTool: false,
    toolName: null,
    params: { askForCallbackWindow: true },
    prompt: ({ params }) =>
      [
        "TAKE A MESSAGE: if the request can't be resolved now, offer to take a message for the team.",
        "Capture who it's from, how to reach them, and what it's about.",
        params.askForCallbackWindow
          ? "Ask when they're best reached."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
  },

  {
    id: "check_order_status",
    label: "Check order status",
    description: "Look up an order or booking reference and report its current status.",
    channels: ["widget", "whatsapp", "voice"],
    requiresTool: true,
    toolName: "check_order_status",
    params: { referenceLabel: "order number" },
    prompt: ({ params }) =>
      [
        `CHECK ORDER STATUS: you can look up an order by its ${params.referenceLabel}.`,
        `Ask for the ${params.referenceLabel} before attempting a lookup.`,
        "Never guess or invent a status.",
      ].join(" "),
  },

  {
    id: "transfer_to_human",
    label: "Transfer to a human",
    description:
      "Hand the conversation to a person — warm transfer on calls, escalation flag on chat.",
    channels: ["widget", "whatsapp", "voice"],
    requiresTool: true,
    toolName: "transfer_to_human",
    params: { allowOnRequest: true },
    prompt: ({ params, channel }) =>
      [
        "TRANSFER TO A HUMAN:",
        params.allowOnRequest
          ? "if the customer asks for a person, agree immediately — never argue or try to handle it yourself first."
          : "escalate only when you genuinely cannot help.",
        channel === "voice"
          ? "Tell them you're transferring them before you do it."
          : "Tell them a team member will pick up the conversation.",
      ].join(" "),
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** @param {string} id */
export function getCapability(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Resolve which capabilities are actually live for this tenant on this channel.
 *
 * A capability is active only when ALL of these hold:
 *   - it exists in the catalog (stale ids in the DB are ignored, not crashes)
 *   - the tenant enabled it
 *   - the catalog says it works on this channel
 *   - the tenant didn't narrow it away from this channel
 *
 * @param {object} args
 * @param {Record<string, {enabled?: boolean, channels?: string[], params?: object}>} args.tenantCapabilities
 *        the `capabilities` JSON from agent_configs
 * @param {string} args.channel  "widget" | "whatsapp" | "voice"
 * @returns {Array<{capability: object, params: object}>}
 */
export function resolveCapabilities({ tenantCapabilities = {}, channel }) {
  const active = [];

  for (const [id, state] of Object.entries(tenantCapabilities)) {
    const capability = BY_ID.get(id);
    if (!capability) continue; // capability removed from the catalog since it was saved
    if (!state?.enabled) continue;
    if (!capability.channels.includes(channel)) continue;

    // `channels` on the tenant side is an optional NARROWING. Absent = all the
    // channels the catalog allows.
    if (Array.isArray(state.channels) && !state.channels.includes(channel)) continue;

    active.push({
      capability,
      // Tenant params override catalog defaults key by key; a tenant that only
      // sets `slotMinutes` still gets the default `services` and `maxDaysAhead`.
      params: { ...capability.params, ...(state.params ?? {}) },
    });
  }

  return active;
}
