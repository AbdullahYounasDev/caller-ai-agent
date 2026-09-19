import { resolveCapabilities } from "./capabilities/catalog";

/**
 * Builds the system instruction. This is where a tenant's configuration stops
 * being a database row and becomes agent behavior.
 *
 * It lives in its own file, separate from respond.js, because prompt text is the
 * thing that changes most often and is hardest to review inside unrelated logic.
 * Every channel gets its prompt from here — that's what stops the widget agent
 * and the phone agent from quietly becoming two different products.
 */

// FLIP THIS TO `true` IN PHASE 4, when tool-calling is actually wired up.
//
// Until then the agent can be TOLD it books appointments, but nothing executes
// the booking. A model told "you can book appointments" with no tool will happily
// answer "you're booked for Tuesday at 3" — a confident lie to a real customer.
// So while this is false, capabilities flagged requiresTool get an explicit
// "gather the details, promise follow-up, never claim it's done" guard instead.
const TOOL_EXECUTION_AVAILABLE = false;

const LANGUAGE_NAMES = {
  en: "English",
  it: "Italian",
  ar: "Arabic",
  ur: "Urdu",
};

const TONE_GUIDANCE = {
  professional: "Warm but businesslike. Courteous, never stiff or chatty.",
  friendly: "Relaxed and personable. Contractions are fine; stay respectful.",
  concise: "Minimal. Answer in as few words as the question allows. No filler.",
  formal: "Formal register throughout. No contractions, no slang.",
};

// How to SPEAK on each channel. Getting this wrong is the most obvious possible
// tell that a product is a chatbot with a phone number bolted on.
const CHANNEL_STYLE = {
  widget:
    "You are in a website chat widget. Keep replies short — two or three sentences. " +
    "Short lists are fine. No headings, no long documents.",

  whatsapp:
    "You are on WhatsApp. Write like a person texting: brief, plain text, no markdown " +
    "formatting or bullet symbols. Break longer thoughts across short messages rather " +
    "than sending a wall of text.",

  voice:
    "You are on a LIVE PHONE CALL and every word you produce is read aloud. " +
    "Never output markdown, asterisks, bullet points, numbered lists, emoji or URLs — " +
    "they are unspeakable. Say 'first… then…' instead of listing. Use short sentences. " +
    "Spell out abbreviations. Keep each turn under about three sentences: the caller " +
    "cannot skim, and they will interrupt a monologue.",
};

/**
 * @param {object} args
 * @param {object} args.config   from lib/tenant/config.js getAgentConfig()
 * @param {string} args.channel  "widget" | "whatsapp" | "voice"
 * @param {string} args.locale   "en" | "it" | "ar" | "ur"
 * @param {Array<{source: string, content: string}>} args.chunks retrieved knowledge
 * @returns {string}
 */
export function buildSystemInstruction({ config, channel, locale, chunks = [] }) {
  const sections = [];

  // --- 1. Who the agent is -------------------------------------------------
  // Identity goes first: it's what the model leans on hardest, and it's the
  // difference between "a generic assistant" and "this business's agent".
  const identity = [`You are the AI assistant for ${config.businessName}.`];
  if (config.purpose?.trim()) {
    identity.push(`What you are here to do, in the business's own words: ${config.purpose.trim()}`);
  }
  identity.push("Speak as part of the business — say 'we' and 'our', never refer to it in the third person.");
  identity.push("Never state or imply that you are a generic AI model, and never name the technology behind you.");
  sections.push(identity.join(" "));

  // --- 2. Tone + channel style --------------------------------------------
  sections.push(`TONE: ${TONE_GUIDANCE[config.tone] ?? TONE_GUIDANCE.professional}`);
  sections.push(`CHANNEL: ${CHANNEL_STYLE[channel] ?? CHANNEL_STYLE.widget}`);

  // --- 3. Language ---------------------------------------------------------
  // Explicit, because retrieved context is very often in a different language
  // from the customer's question and the model will otherwise drift into the
  // language of the documents it just read.
  const languageName = LANGUAGE_NAMES[locale] ?? LANGUAGE_NAMES.en;
  sections.push(
    `LANGUAGE: reply in ${languageName}. Reply in ${languageName} even when the ` +
      `reference material below is written in another language — translate what you need. ` +
      `If the customer switches language mid-conversation, switch with them.`
  );

  // --- 4. Business hours ---------------------------------------------------
  if (config.hours) {
    sections.push(
      `BUSINESS HOURS (timezone ${config.timezone}): ${formatHours(config.hours)}. ` +
        `Use these when the customer asks when you're open, and never offer a time outside them.`
    );
  }

  // --- 5. What the agent can actually DO -----------------------------------
  const active = resolveCapabilities({
    tenantCapabilities: config.capabilities,
    channel,
  });

  if (active.length) {
    const lines = active.map(({ capability, params }) =>
      `- ${capability.prompt({ params, channel })}`
    );
    sections.push(`WHAT YOU CAN DO FOR THE CUSTOMER:\n${lines.join("\n")}`);

    // The anti-hallucination guard described at TOOL_EXECUTION_AVAILABLE above.
    const pending = active.filter(({ capability }) => capability.requiresTool);
    if (!TOOL_EXECUTION_AVAILABLE && pending.length) {
      sections.push(
        "CRITICAL — you cannot yet complete these actions yourself: " +
          pending.map(({ capability }) => capability.label).join(", ") + ". " +
          "Gather every detail needed and tell the customer a team member will confirm shortly. " +
          "NEVER say an action is done, booked, cancelled or processed. Do not invent " +
          "reference numbers, confirmation codes or times."
      );
    }
  }

  // --- 6. Escalation -------------------------------------------------------
  if (config.escalation) {
    sections.push(`ESCALATION: ${formatEscalation(config.escalation)}`);
  }

  // --- 7. Knowledge + the grounding rule -----------------------------------
  // Last on purpose: it's the longest section and the rule that must survive
  // contact with it sits immediately after, where recency helps.
  const contextBlock = chunks.length
    ? chunks.map((c, i) => `[${i + 1}] (source: ${c.source})\n${c.content}`).join("\n\n")
    : "No reference material matched this question.";

  sections.push(
    `REFERENCE MATERIAL FROM ${config.businessName.toUpperCase()}:\n${contextBlock}`
  );

  sections.push(
    "GROUNDING RULE: answer from the reference material above whenever it covers the " +
      "question. If it does not, say you don't have that information and offer to connect " +
      "them with the team. Never guess or invent policy, pricing, availability, or facts " +
      "about the business. An honest 'I don't know' is always better than a plausible " +
      "answer you made up — a wrong answer here becomes the business's problem, not yours."
  );

  return sections.join("\n\n");
}

/**
 * { mon: [["09:00","17:00"]], sun: [] } -> "mon 09:00-17:00; sun closed"
 * Tolerant by design: hours is free-form JSON a dashboard writes, and a malformed
 * value should degrade to a readable line, not throw mid-conversation.
 */
function formatHours(hours) {
  if (typeof hours === "string") return hours;
  if (!hours || typeof hours !== "object") return "not specified";

  return Object.entries(hours)
    .map(([day, ranges]) => {
      if (!Array.isArray(ranges) || ranges.length === 0) return `${day} closed`;
      const spans = ranges
        .map((r) => (Array.isArray(r) ? `${r[0]}-${r[1]}` : String(r)))
        .join(", ");
      return `${day} ${spans}`;
    })
    .join("; ");
}

function formatEscalation(escalation) {
  if (typeof escalation === "string") return escalation;

  const parts = [];
  if (escalation.whenUserAsks !== false) {
    parts.push("If the customer asks for a human, agree immediately and stop trying to resolve it yourself.");
  }
  if (escalation.whenAgentUnsure) {
    parts.push("If you are unsure or the customer is frustrated, offer a human rather than guessing.");
  }
  // Contact details are deliberately NOT handed to the model as text it may read
  // out: it will volunteer them unprompted. Phase 4's transfer_to_human tool is
  // what actually routes the conversation.
  if (escalation.email || escalation.phone) {
    parts.push("A route to a human exists — offer it, and the system will handle the handoff.");
  }
  return parts.join(" ") || "Offer a human when you cannot help.";
}
