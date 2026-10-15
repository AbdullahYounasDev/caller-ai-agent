import { resolveCapabilities } from "./capabilities/catalog";
import { t, DEFAULT_LOCALE } from "@/lib/i18n";
import { PLACEHOLDER_BUSINESS_NAME } from "@/lib/tenant/config";
import { humanizeTitle } from "./chunk";
import { SPOKEN_LANGUAGES, voiceFor } from "@/lib/voice/speech/voices";

/**
 * Builds the system instruction. This is where a tenant's configuration stops
 * being a database row and becomes agent behavior.
 *
 * It lives in its own file, separate from respond.js, because prompt text is the
 * thing that changes most often and is hardest to review inside unrelated logic.
 * Every channel gets its prompt from here — that's what stops the test chat
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
  // The INTERNAL TEST SURFACE. Kept close to how a person reads a transcript,
  // so what you see while testing is close to what the call will say.
  chat:
    "You are in a chat window. Keep replies short — two or three sentences. " +
    "Short lists are fine. No headings, no long documents.",

  // THE REAL CHANNEL. Every word is spoken aloud by a text-to-speech voice,
  // which is why these constraints are harder than for text: markdown is
  // unspeakable, a caller cannot skim, and they will talk over a monologue.
  voice:
    "You are on a LIVE PHONE CALL and every word you produce is read aloud. " +
    "Never output markdown, asterisks, bullet points, numbered lists, emoji or URLs — " +
    "they are unspeakable. Say 'first… then…' instead of listing. Use short sentences. " +
    "Spell out abbreviations. Keep each turn under about three sentences: the caller " +
    "cannot skim, and they will interrupt a monologue. Open with a short first sentence — " +
    "the caller hears it while the rest is still being prepared. Say times, dates and " +
    "prices the way a person says them out loud ('nine in the morning to six in the " +
    "evening', not '09:00–18:00' or 'zero nine hundred'). Do not mention which document or " +
    "update date an answer comes from unless two documents disagree. If you reply in Urdu, " +
    "write it in Urdu script, never in Roman (Latin-letter) Urdu: an Urdu voice reads it aloud.",
};

const GENDER_WORDS = { female: "feminine", male: "masculine" };

/**
 * ON A CALL, THE AGENT HAS A GENDER — the voice the business picked. In languages where
 * the speaker's gender changes the words (Urdu "میں کر سکتی ہوں" vs "کر سکتا ہوں", Italian
 * "sono lieta" vs "sono lieto"), a female voice speaking masculine forms is immediately
 * wrong to a native caller. Only the languages this call can actually be spoken in are
 * described, and the voice per language comes from the same voiceFor() the gateway
 * speaks with, so the grammar always matches the voice the caller hears.
 */
function voiceGenderInstruction(config) {
  const languages = config.replyLanguage === "auto" ? SPOKEN_LANGUAGES : [config.replyLanguage];
  const genders = languages.map((lang) => [lang, voiceFor(config.voices, lang).gender]);
  const distinct = new Set(genders.map(([, g]) => g));
  const rule =
    distinct.size === 1
      ? `Your voice on this call is ${[...distinct][0]}.`
      : `Your voice on this call is ${genders.map(([lang, g]) => `${g} in ${LANGUAGE_NAMES[lang]}`).join(", ")}.`;
  const forms = distinct.size === 1 ? `the ${GENDER_WORDS[[...distinct][0]]} forms` : "the forms that match that voice";
  return (
    `VOICE: ${rule} In languages where words change with the speaker's gender (such as Urdu ` +
    `and Italian), always use ${forms} when you speak about yourself.`
  );
}

/**
 * ON A CALL, THE CUSTOMER'S WORDS ARE A TRANSCRIPT. The speech recogniser has never heard
 * the business's names and spells them as it hears them: one real call produced "Nairan",
 * "Niron" and "Nairawan" for "Nyron". The gateway corrects the business name itself
 * (lib/voice/vocabulary.js), but not product names or what it fails to match — and,
 * measured on that call, the model then answered "I don't have that information" even with
 * the company overview retrieved, because the caller seemed to ask about something else.
 */
function voiceHearingInstruction(config) {
  const name =
    config.businessName && config.businessName !== PLACEHOLDER_BUSINESS_NAME ? ` (${config.businessName})` : "";
  return (
    "HEARING: the customer's words reach you through automatic speech recognition, which often " +
    `misspells names. A word that sounds like the business's name${name} or like a name in the ` +
    "reference material means that name: answer about it, and never say you have no information " +
    "only because the spelling differs. If you genuinely cannot tell what was said, ask the " +
    "customer to repeat it."
  );
}

/**
 * @param {object} args
 * @param {object} args.config   from lib/tenant/config.js getAgentConfig()
 * @param {string} args.channel  "chat" | "voice"
 *   NOTE: there is no `locale` parameter. The reply language comes from
 *   `config.replyLanguage` ("en" | "it" | "ur" | "auto"); the INTERFACE language is a
 *   presentation concern and must never leak into the prompt.
 * @param {Array<{source: string, content: string}>} args.chunks retrieved knowledge
 * @returns {string}
 */
export function buildSystemInstruction({ config, channel, chunks = [] }) {
  const sections = [];

  // --- 1. Who the agent is -------------------------------------------------
  // Identity goes first: it's what the model leans on hardest, and it's the
  // difference between "a generic assistant" and "this business's agent".
  // What the business DOES lives in the ABOUT THIS BUSINESS block (section 4),
  // not here — one labelled place the grounding rule can point at (§6.20).
  const identity = [`You are the AI assistant for ${config.businessName}.`];
  identity.push("Speak as part of the business — say 'we' and 'our', never refer to it in the third person.");
  identity.push("Never state or imply that you are a generic AI model, and never name the technology behind you.");
  sections.push(identity.join(" "));

  // --- 2. Tone + channel style --------------------------------------------
  sections.push(`TONE: ${TONE_GUIDANCE[config.tone] ?? TONE_GUIDANCE.professional}`);
  sections.push(`CHANNEL: ${CHANNEL_STYLE[channel] ?? CHANNEL_STYLE.chat}`);
  if (channel === "voice") {
    sections.push(voiceGenderInstruction(config));
    sections.push(voiceHearingInstruction(config));
  }

  // --- 3. Language ---------------------------------------------------------
  // Always explicit, in both modes. Retrieved context is very often in a
  // different language from the customer's question, and without an instruction
  // the model drifts into the language of the documents it just read.
  if (config.replyLanguage === "auto") {
    // "Match the customer's language" — the business made no fixed choice, so
    // the customer's own words decide. The knowledge base is usually in one
    // language and the customer may write in another; saying so explicitly is
    // what stops the model answering an Italian question in English simply
    // because the price list was English.
    sections.push(
      "LANGUAGE: reply in THE SAME LANGUAGE THE CUSTOMER WROTE IN. Detect it from " +
        "their message and mirror it exactly — including if that is a language the " +
        "reference material below is not written in; translate what you need. " +
        "If the customer switches language mid-conversation, switch with them and " +
        "stay switched. Never announce or comment on which language you are using."
    );
  } else {
    const languageName = LANGUAGE_NAMES[config.replyLanguage] ?? LANGUAGE_NAMES.en;
    // The business fixed a language, so it wins even when the customer writes
    // in another one — that is the point of choosing it rather than "auto".
    sections.push(
      `LANGUAGE: always reply in ${languageName}, whatever language the customer ` +
        `writes in. Reply in ${languageName} even when the reference material below ` +
        `is in another language — translate what you need.`
    );
  }

  // --- 4. About this business ----------------------------------------------
  // The business profile: name + purpose + hours, always in the prompt, whether
  // or not retrieval found anything. It exists because the most common opening
  // question on a call — "who are you / what do you do" — often retrieves
  // NOTHING (§6.20): it has no keyword to match, so it embeds too far from every
  // chunk to clear MAX_DISTANCE, and that distance cannot be loosened without
  // letting off-topic questions through (§6.3). Before this block the model HAD
  // the name and purpose in its identity line, but the grounding rule told it to
  // answer only from reference material, so it declined.
  //
  // Every line is something the owner typed into the config — nothing is
  // inferred — and the grounding rule below limits the model to restating it.
  const hasName = config.businessName && config.businessName !== PLACEHOLDER_BUSINESS_NAME;
  const purpose = config.purpose?.trim();
  const profile = [];
  if (hasName) profile.push(`Name: ${config.businessName}`);
  if (purpose) profile.push(`What we do, in the business's own words: ${purpose}`);
  if (config.hours) {
    profile.push(
      `Business hours (timezone ${config.timezone}): ${formatHours(config.hours)}. ` +
        `Use these when the customer asks when you're open, and never offer a time outside them.`
    );
  }
  const hasProfile = profile.length > 0;
  if (hasProfile) sections.push(`ABOUT THIS BUSINESS:\n${profile.join("\n")}`);

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
      // English labels on purpose: this sentence sits inside an English system
      // instruction addressed to the model, not to the customer. The customer-
      // facing language is set by the LANGUAGE section above.
      const pendingLabels = pending
        .map(({ capability }) =>
          t({ locale: DEFAULT_LOCALE, key: `capabilities:${capability.id}.label` })
        )
        .join(", ");

      sections.push(
        "CRITICAL — you cannot yet complete these actions yourself: " +
          pendingLabels + ". " +
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
  // Citing the document title AND the heading gives the model something
  // specific to name — "our price list says" beats "our records show" — and
  // makes a wrong answer traceable back to the document that caused it.
  //
  // THE LABEL SAYS "document", and when more than one document is present a
  // line above the passages says so out loud. The conflict rule below only works if
  // the model registers that [1] and [2] are DIFFERENT documents rather than two
  // paragraphs of one: with the old "(source: …)" label and no such line, a model
  // shown 179 once and 149 twice tended to treat it as a majority vote and
  // answer with one number (§6.10).
  const documents = new Set(chunks.map((c) => c.sourceTitle));
  const manyDocuments = documents.size > 1;
  // The label shows a document as a person would say it ("storepulse price list"), not as a
  // file name ("08-storepulse-price-list-conflict.txt"): the model repeats what it is shown,
  // and a first live run read the whole file name and its number prefix out to the customer —
  // unspeakable on a call. If two different documents would humanise to the SAME name
  // (01-plans.md and 02-plans.md), the raw titles are kept so they stay distinguishable.
  const spoken = new Map([...documents].map((t) => [t, humanizeTitle(t) || t]));
  const nameOf = new Set(spoken.values()).size === spoken.size ? spoken : new Map([...documents].map((t) => [t, t]));
  const contextBlock = chunks.length
    ? (manyDocuments
        ? `NOTE: these passages come from ${documents.size} DIFFERENT documents, named in each label. Different documents can state different values for the same thing.\n\n`
        : "") +
      chunks
        .map((c, i) => {
          const section = c.heading ? `, section: ${c.heading}` : "";
          // The date is here for the conflict rule below, written the way it would be said.
          const updated = c.sourceUpdatedAt ? `, updated ${readableDate(c.sourceUpdatedAt)}` : "";
          return `[${i + 1}] (document: "${nameOf.get(c.sourceTitle)}"${section}${updated})\n${c.content}`;
        })
        .join("\n\n")
    : // Retrieval returned nothing ABOVE THE RELEVANCE THRESHOLD — which is
      // different from the business having no documents, and the model must not
      // paper over either case. See MAX_DISTANCE in retrieve.js.
      "NOTHING IN THIS BUSINESS'S DOCUMENTS IS RELEVANT TO THIS QUESTION.";

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

  // The ONE exception to "reference material only", and deliberately narrow.
  // Without it a caller's first question ("who are you?") is declined by an
  // agent whose own prompt names the business (§6.20). The limits matter as much
  // as the permission: the profile is a short description, not a catalogue, and
  // a model allowed to "elaborate" on it produces plausible products and prices
  // the business never listed — the §6.11 failure through a different door.
  if (hasProfile) {
    sections.push(
      "ABOUT THIS BUSINESS above is always available to you, even when the reference " +
        "material has nothing relevant. Use it to answer who you are, what the business " +
        "does and, if given, when it is open. Restate only what it says: never turn it into " +
        "specific products, services, prices, features, locations or claims it does not " +
        "name. If it gives no description of what the business does, do not guess one from " +
        "the business's name. If the customer wants more detail than it gives — what exactly is sold, what " +
        "it costs — that comes from the reference material only, and if that does not " +
        "have it, say you don't have it."
    );
  }

  // CONFLICTING DOCUMENTS. Businesses keep the same fact in two documents and
  // correct only one — a price list and a pricing sheet that disagree. Both retrieve,
  // both look authoritative, and a model left to choose picks whichever reads better
  // or simply the one that appears more often. Observed in testing: a corrected price
  // lost to a stale one, and a reply that gave one price and never said another
  // document existed.
  //
  // The rule used to be "prefer the most recently updated one, and mention it", which
  // has two flaws: it invites the model to resolve the conflict itself (so the
  // customer is told one number with false confidence), and recency cannot decide
  // when both documents carry the same date. So it now asks for BOTH values, each
  // with the document and the date it came from, and a team confirmation: a
  // customer told "the price list says X, dated A; the pricing sheet says Y, dated B"
  // can act on it, a silently-picked number just becomes a bad quote.
  //
  // WHEN IT IS INCLUDED. Only when the passages come from two or more DIFFERENT
  // documents — two paragraphs of one document are not a disagreement between
  // sources — and the last clause tells the model to stay silent when the documents
  // merely repeat the same value, which is the common case and must not turn every
  // answer into a discrepancy warning.
  //
  // It sits LAST, after the reference block and the grounding rule, where recency
  // helps it survive the length of the passages. Three sentences, no markdown, no
  // digits and no file names to read aloud: it is voice-safe (§9.2), which is why the
  // model is told to say each document by its plain name.
  if (manyDocuments) {
    sections.push(
      "IF DOCUMENTS DISAGREE: when two different documents above give different values for the same " +
        "thing — a price, a limit, a date — do not pick one: give both values, say which document each " +
        "came from by its plain name without the file extension and the date it was updated, then offer " +
        "to have the team confirm. You may say which is newer, but still give both and never average them. " +
        "If the documents give the same value, just answer normally and say nothing about documents or any discrepancy."
    );
  }

  return sections.join("\n\n");
}

/**
 * THE AGENT'S OPENING LINE ON A CALL — spoken the instant the call connects, before the
 * caller says anything (§6.24).
 *
 * A fixed template, NOT a model call, on purpose: it is the one moment of the call where
 * latency is pure dead air (the caller is waiting to hear someone pick up), it costs no
 * quota, and there is nothing to retrieve yet. It lives here because every word the agent
 * says that is not generated is still agent wording, and prompt.js is where that is
 * reviewed — not in the voice code.
 *
 * Its language: the business's fixed reply language, or English when the reply language
 * is "auto" — before the caller has said a word there is nothing to mirror. The INTERFACE
 * language is deliberately not consulted (§7: it must never leak into what the agent
 * says). From the caller's first sentence on, "auto" mirrors them as usual.
 *
 * Voice-safe (no markdown, digits or URLs), and a question, so the caller knows it is
 * their turn. In Urdu the closing verb agrees with the VOICE's gender ("سکتی" / "سکتا") —
 * the same rule voiceGenderInstruction gives the model for everything after.
 *
 * @param {object} config from getAgentConfig()
 * @returns {{text: string, language: "en"|"it"|"ur"}}
 */
export function buildVoiceGreeting(config) {
  const language = ["it", "ur"].includes(config?.replyLanguage) ? config.replyLanguage : "en";
  const name =
    config?.businessName && config.businessName !== PLACEHOLDER_BUSINESS_NAME ? config.businessName : null;

  let text;
  if (language === "ur") {
    const can = voiceFor(config?.voices, "ur").gender === "female" ? "سکتی" : "سکتا";
    text = `السلام علیکم، ${name ? `${name} کو ` : ""}کال کرنے کا شکریہ۔ میں آپ کی کیا مدد کر ${can} ہوں؟`;
  } else if (language === "it") {
    text = name
      ? `Buongiorno, grazie per aver chiamato ${name}. Come posso aiutarla?`
      : "Buongiorno, grazie per la chiamata. Come posso aiutarla?";
  } else {
    text = name
      ? `Hello, thanks for calling ${name}. How can I help you today?`
      : "Hello, thanks for calling. How can I help you today?";
  }

  return { text, language };
}

/**
 * The other fixed things the agent may SAY on a call, in each spoken language (§6.24):
 *
 *   filler    spoken when a turn has been silent for VOICE_FILLER.afterMs with no reply
 *             audio yet — a slow provider or a follow-up rewrite (§6.19). Dead air on a
 *             phone line reads as a dropped call; a short "one moment" does not.
 *   fallback  spoken when a turn FAILED (quota, outage). The caller must hear something
 *             true and short, never silence and never an error code (§6.16).
 *
 * Fixed text for the same reasons as the greeting: no model call, no quota, no latency.
 * Fillers come in a few phrasings, rotated by `variant`, because the same words at the
 * start of every slow turn is exactly what makes an agent sound like a machine. Every
 * Urdu line avoids first-person verbs, so none of them depends on the voice's gender.
 *
 * @param {"filler"|"fallback"} kind
 * @param {"en"|"it"|"ur"} language
 * @param {number} [variant]  any integer; picks one of the phrasings
 * @returns {string}
 */
export function voiceLine(kind, language, variant = 0) {
  const lines = {
    filler: {
      en: ["Let me check that for you.", "Sure, just a moment.", "One second, please."],
      it: ["Controllo subito.", "Un attimo, per favore.", "Un momento, verifico."],
      ur: ["جی، ایک لمحہ۔", "جی، ذرا ایک لمحہ دیجیے۔"],
    },
    fallback: {
      en: ["Sorry, I'm having trouble answering right now. Could you try again in a moment?"],
      it: ["Mi scusi, in questo momento ho difficoltà a rispondere. Può riprovare tra poco?"],
      ur: ["معذرت، اس وقت جواب دینے میں دشواری ہو رہی ہے۔ کیا آپ تھوڑی دیر میں دوبارہ پوچھ سکتے ہیں؟"],
    },
  };
  const options = lines[kind][["it", "ur"].includes(language) ? language : "en"];
  return options[Math.abs(Math.trunc(variant)) % options.length];
}

/**
 * SYSTEM INSTRUCTION for the query-rewrite step (lib/agent/query.js) — NOT the
 * customer-facing agent prompt. This model call never speaks to a customer; its
 * only output is a search string handed to retrieval.
 *
 * Two rules carry the weight and both exist because of a specific way this goes
 * wrong, so neither should be softened:
 *
 *  - KEEP THE CUSTOMER'S LANGUAGE. The embedding model is multilingual and an
 *    Italian question already retrieves English documents well (eval:real,
 *    cross_language, 100% hit@1). A rewrite that quietly translated "E il
 *    Growth?" into English would not improve that, and would break the one
 *    thing — mirroring the speaker (§7) — that every downstream step assumes.
 *  - NEVER ADD FACTS. A rewrite is a search key, not an answer. If the model
 *    "helpfully" adds a price or a plan name the customer never mentioned, the
 *    search is steered toward whatever it invented and the grounding rule
 *    downstream has no way to know the question was bent on the way in.
 *
 * The "return it unchanged" clause matters just as much: most messages in a
 * call are NOT follow-ups, and a new, unrelated question must not be glued onto
 * the previous topic — that is how an off-topic question starts retrieving a
 * price list.
 */
export function buildQueryRewriteInstruction() {
  return [
    "You turn the LATEST customer message of a conversation into ONE standalone search query for a business's knowledge base.",
    "RULES:",
    "- Output ONLY the search query: a single line, no quotes, no label, no explanation.",
    "- Resolve pronouns and elliptical phrasing (\"and the Pro one?\", \"what about Sundays?\", \"is that included?\", \"E il Growth?\") using the earlier conversation, so the query makes sense with no context at all.",
    "- Use ONLY words, names and facts that already appear in the conversation. Do NOT answer the question. Do NOT add prices, numbers, policies or product details that are not already there. Do NOT guess a product or plan the customer never mentioned.",
    "- Write the query in THE SAME LANGUAGE as the customer's latest message. Italian stays Italian. Never translate it.",
    "- If the latest message is already complete and clear on its own, OR it starts a new topic unrelated to the earlier conversation, OR it is only a greeting, thanks or acknowledgement, return it EXACTLY as written.",
  ].join("\n");
}

/**
 * The single user turn sent with the instruction above: the recent conversation
 * plus the message to rewrite. Each prior turn is truncated — the rewrite only
 * needs the entities and the topic, and a long assistant answer would just
 * spend tokens (and latency, on a phone call) re-reading itself.
 *
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.history prior turns, oldest first
 * @param {string} args.message the latest customer message
 */
export function buildQueryRewriteInput({ history, message }) {
  const clip = (text) => {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
  };
  const transcript = history
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Customer"}: ${clip(m.content)}`)
    .join("\n");

  return (
    `CONVERSATION SO FAR:\n${transcript}\n\n` +
    `LATEST CUSTOMER MESSAGE:\n${clip(message)}\n\n` +
    "STANDALONE SEARCH QUERY:"
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * 2026-09-29T02:58:57Z -> "29 September 2026". Fixed English month names and UTC on purpose:
 * the prompt is addressed to the model, which translates it into the customer's language,
 * and the output must not depend on the server's locale or time zone. An ISO date in the
 * label gets read aloud as "two thousand twenty-six dash zero nine…".
 */
function readableDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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
