import { resolveCapabilities } from "./capabilities/catalog";
import { t, DEFAULT_LOCALE } from "@/lib/i18n";
import { PLACEHOLDER_BUSINESS_NAME } from "@/lib/tenant/config";
import { humanizeTitle } from "./chunk";
import { SPOKEN_LANGUAGES, voiceFor } from "@/lib/voice/speech/voices";
import { buildGreeting } from "@/lib/voice/greeting";
import { digitsAsWords } from "@/lib/collect/validate";
import { markerFor } from "@/lib/collect/marker";

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

// The only two languages the product speaks (§7). The agent UNDERSTANDS both whichever
// is chosen; the chosen one is what it answers in.
const LANGUAGE_NAMES = {
  en: "English",
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

// Aim at a conclusion, never at hurrying the caller. Owners asked for the agent to lead a
// conversation to a result — an answer given, a request noted, a person connected — without
// ever sounding impatient, so both halves are stated, and the second half is the stronger.
const HELPING_STYLE =
  "Be solution-oriented: work out what the caller needs, answer it directly, and move toward a clear next step or " +
  "conclusion (a question answered, a request noted, a person connected). Ask at most ONE question at a time, never " +
  "repeat back what the caller just said word for word, and keep to what they asked. But never rush, hurry, interrupt " +
  "or talk down to anyone: be patient, polite and warm, let people take their time, and never end a thought with a " +
  "push to finish. When their need is met, ask once whether there is anything else; if there is not, close briefly and " +
  "kindly (thank them and say goodbye).";

// The call ends by itself once the conversation is over (lib/voice/closing.js). At that moment a
// reply that asks one more question keeps the line open, and a goodbye said while the caller still
// needs something would end the call on them — so both are spelled out, for calls only.
const CALL_ENDING_STYLE =
  "ENDING THE CALL: when the caller says goodbye, or says there is nothing else, reply with ONE short, warm sentence " +
  "that thanks them and says goodbye, and ask nothing more: the call ends by itself after your goodbye. Never say " +
  "goodbye while the caller still needs something.";

const GENDER_WORDS = { female: "feminine", male: "masculine" };

/**
 * ON A CALL, THE AGENT HAS A GENDER — the voice the business picked. In Urdu the speaker's
 * gender changes the words ("میں کر سکتی ہوں" vs "کر سکتا ہوں"), so a female voice speaking
 * masculine forms is immediately wrong to a native caller. The voice comes from the same
 * voiceFor() the gateway speaks with, so the grammar always matches what the caller hears.
 * The call is spoken in the business's reply language only.
 */
function voiceGenderInstruction(config) {
  const language = SPOKEN_LANGUAGES.includes(config.replyLanguage) ? config.replyLanguage : "en";
  const gender = voiceFor(config.voices, language).gender;
  return (
    `VOICE: Your voice on this call is ${gender}. In languages where words change with the ` +
    `speaker's gender (such as Urdu), always use the ${GENDER_WORDS[gender]} forms when you ` +
    `speak about yourself.`
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
    "only because the spelling differs. The customer may speak English, Urdu, or both in one " +
    "sentence, and the transcript may write English words in Urdu script or Urdu words in Latin " +
    "letters: read it for its meaning. If you genuinely cannot tell what was said, ask the " +
    "customer to repeat it."
  );
}

/**
 * @param {object} args
 * @param {object} args.config   from lib/tenant/config.js getAgentConfig()
 * @param {string} args.channel  "chat" | "voice"
 *   NOTE: there is no `locale` parameter. The reply language comes from
 *   `config.replyLanguage` ("en" | "ur"); the INTERFACE language is a
 *   presentation concern and must never leak into the prompt.
 * @param {Array<{source: string, content: string}>} args.chunks retrieved knowledge
 * @param {object|null} [args.collection] this turn's plan for taking a customer's request
 *   (lib/collect/engine.js); null when the business takes none
 * @param {{kind: string}|null} [args.opener] this message is a generic opener (lib/phrases, §6.20):
 *   "who are you", "what do you do", "are you a robot?"
 * @returns {string}
 */
export function buildSystemInstruction({ config, channel, chunks = [], collection = null, handoff = null, opener = null }) {
  const sections = [];

  // --- 1. Who the agent is -------------------------------------------------
  // Identity goes first: it's what the model leans on hardest, and it's the
  // difference between "a generic assistant" and "this business's agent".
  // What the business DOES lives in the ABOUT THIS BUSINESS block (section 4),
  // not here — one labelled place the grounding rule can point at (§6.20).
  const identity = [`You are the AI assistant for ${config.businessName}.`];
  identity.push("Speak as part of the business — say 'we' and 'our', never refer to it in the third person.");
  identity.push("Never state or imply that you are a generic AI model, and never name the technology behind you.");
  // Callers are told at pick-up (or not — the greeting is the owner's, lib/voice/greeting.js), but
  // a direct question always gets a true answer: claiming to be a person is never acceptable.
  identity.push("If the customer asks whether they are talking to a person, a robot or an AI, say honestly that you are the business's AI assistant; never claim to be a human.");
  sections.push(identity.join(" "));

  // --- 2. Tone + channel style --------------------------------------------
  sections.push(`TONE: ${TONE_GUIDANCE[config.tone] ?? TONE_GUIDANCE.professional}`);
  sections.push(`CHANNEL: ${CHANNEL_STYLE[channel] ?? CHANNEL_STYLE.chat}`);
  sections.push(`HOW YOU HELP: ${HELPING_STYLE}`);
  if (channel === "voice") {
    sections.push(voiceGenderInstruction(config));
    sections.push(voiceHearingInstruction(config));
    if (config.autoEndCalls !== false) sections.push(CALL_ENDING_STYLE);
  }

  // --- 3. Language ---------------------------------------------------------
  // Two languages, both UNDERSTOOD, one ANSWERED. Pakistani callers switch between
  // Urdu and English inside a sentence ("Pro plan کی fee کیا ہے؟") and write Urdu in
  // Roman letters ("iska price kya hai"); the model has to read all of it, and the
  // business's choice decides what comes back. Retrieved context is very often in the
  // other language from the reply, and without an explicit instruction the model drifts
  // into the language of the documents it just read.
  const replyName = LANGUAGE_NAMES[config.replyLanguage] ?? LANGUAGE_NAMES.en;
  const otherName = config.replyLanguage === "ur" ? LANGUAGE_NAMES.en : LANGUAGE_NAMES.ur;
  const language = [
    "LANGUAGE: the customer may write or speak English, Urdu (in Urdu script or in Roman " +
      "letters), or a mix of both in one sentence. Understand all of it equally well. " +
      `ALWAYS reply in ${replyName}, whatever language the customer used and even when the ` +
      `reference material below is in ${otherName} — translate what you need. Never announce ` +
      "or comment on which language you are using, and do not ask the customer to switch.",
  ];
  if (config.replyLanguage === "ur") {
    language.push(
      "Write Urdu in Urdu script, never in Roman letters. Write everyday English loanwords " +
        "(clinic, appointment, doctor) in Urdu script too; keep only brand names and codes in their " +
        "original spelling."
    );
    if (channel === "voice") {
      language.push(
        "You are speaking: write numbers, prices and times as Urdu words, the way a person says them " +
          "aloud (for example پندرہ سو روپے), never as digits."
      );
    }
  }
  sections.push(language.join(" "));

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
  // What THIS turn does about a person (lib/handoff/decide.js) is decided by code; the model
  // only words it. The standing rule below exists because a model that promises "I'll connect
  // you" when the system is not actually doing it leaves a caller waiting on a line that goes
  // nowhere.
  if (config.escalation?.enabled && config.escalation.contacts?.length) {
    sections.push(
      "PASSING THE CALLER TO A PERSON: you cannot transfer anyone yourself and you never read out a phone number. " +
        "Only when this turn's instructions below say the caller is being connected may you say so. If the caller " +
        "wants a person and no such instruction is given, say you will help as far as you can, and that they can " +
        "say plainly 'connect me to a person' at any time."
    );
  }
  const passing = handoff ? buildHandoffInstruction(handoff, { channel }) : null;
  if (passing) sections.push(passing);

  // --- 6b. Taking a request (appointment, callback…) -------------------------
  // The engine decides what happens this turn (lib/collect/engine.js); this section only
  // tells the model what to SAY about it. It sits before the reference material so the
  // grounding rule and the conflict rule stay the last things the model reads.
  const collecting = collection ? buildCollectionInstruction(collection, { channel }) : null;
  if (collecting) sections.push(collecting);

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

  // THIS MESSAGE IS A GENERIC OPENER (lib/phrases, §6.20). Said on most calls, first: "who are you",
  // "tell me about your company", "aap kya karte hain". Without a word on it the model, seeing an
  // overview chunk or none, sometimes declined. It still may say nothing the profile or the passages
  // do not — the exception above keeps its limits.
  if (opener?.kind === "aiCheck") {
    sections.push(
      "THIS MESSAGE asks whether you are a person or a machine. Say plainly, in one sentence, that you are the AI " +
        `assistant for ${hasName ? config.businessName : "this business"}, then ask how you can help.`
    );
  } else if (opener) {
    sections.push(
      "THIS MESSAGE is a general question about the business — who you are, what it does or what it offers. " +
        "Answer it in two or three short sentences from ABOUT THIS BUSINESS and from any passage above that " +
        "describes the business as a whole. Mention kinds of products or services only if they are named there. " +
        "Then ask what they would like help with."
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
 * A fixed text, NOT a model call, on purpose: it is the one moment of the call where latency is
 * pure dead air, it costs no quota, and there is nothing to retrieve yet. Each agent has its OWN:
 * the owner's words, or the built-in greeting that tells the caller they are speaking with an AI
 * assistant (and, only while recording is on, that the call is recorded). The wording and the
 * rules live in lib/voice/greeting.js — pure, because the console previews it as the owner types.
 *
 * Its language: the business's reply language. The INTERFACE language is deliberately not
 * consulted (§7: it must never leak into what the agent says).
 *
 * @param {object} config from getAgentConfig()
 * @returns {{text: string, language: "en"|"ur", custom: boolean}}
 */
export function buildVoiceGreeting(config) {
  const name =
    config?.businessName && config.businessName !== PLACEHOLDER_BUSINESS_NAME ? config.businessName : null;
  return buildGreeting(config, { businessName: name });
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
 * @param {"filler"|"fallback"|"unheard"|"connecting"|"not_in_service"|"handoff_failed"|"still_there"|"silence_goodbye"|"take_your_time"|"listening"|"closing"} kind
 * @param {"en"|"ur"} language
 * @param {number} [variant]  any integer; picks one of the phrasings
 * @returns {string}
 */
export function voiceLine(kind, language, variant = 0) {
  const lines = {
    filler: {
      en: ["Let me check that for you.", "Sure, just a moment.", "One second, please."],
      ur: ["جی، ایک لمحہ۔", "جی، ذرا ایک لمحہ دیجیے۔"],
    },
    fallback: {
      en: ["Sorry, I'm having trouble answering right now. Could you try again in a moment?"],
      ur: ["معذرت، اس وقت جواب دینے میں دشواری ہو رہی ہے۔ کیا آپ تھوڑی دیر میں دوبارہ پوچھ سکتے ہیں؟"],
    },
    // Fixed lines for the moments no model is involved. Urdu wording is deliberately free of
    // gendered verb forms (the agent's voice may be either) and of Latin-letter names (the
    // Urdu voice would spell them out).
    unheard: {
      en: ["Sorry, I didn't catch that. Could you say it again, please?", "I'm sorry, the line wasn't clear. Could you repeat that for me?"],
      ur: ["معذرت، آواز واضح نہیں آئی۔ کیا آپ دوبارہ بتا سکتے ہیں؟", "معذرت، بات سمجھ نہیں آئی۔ براہِ کرم ایک بار پھر کہیے۔"],
    },
    // Said before the transfer line (lib/handoff/announce.js), which names who the caller is passed to.
    connecting: {
      en: ["I'm sorry, I couldn't understand."],
      ur: ["معذرت، بات واضح نہیں ہو سکی۔"],
    },
    // A call to a number that rings no agent (unknown, released, not linked yet, the agent or the
    // business not in service — §6.29). Said by the phone transport before it hangs up; there is no
    // business to name and no agent to answer, so it is the same plain line for every reason.
    not_in_service: {
      en: ["Sorry, this number is not in service at the moment. Please try again later. Goodbye."],
      ur: ["معذرت، یہ نمبر اس وقت سروس میں نہیں ہے۔ براہِ کرم بعد میں دوبارہ کوشش کیجیے۔ خدا حافظ۔"],
    },
    handoff_failed: {
      en: ["I'm sorry, nobody is available to take the call right now. I can take your details and have someone call you back."],
      ur: ["معذرت، اس وقت کوئی دستیاب نہیں ہے۔ ہم آپ کی تفصیل لکھ لیتے ہیں تاکہ ٹیم آپ کو واپس کال کرے۔"],
    },
    still_there: {
      en: ["Are you still there?", "Hello, are you still with me?"],
      ur: ["کیا آپ لائن پر ہیں؟", "ہیلو، کیا آپ میرے ساتھ ہیں؟"],
    },
    silence_goodbye: {
      en: ["I can't hear you, so I'll end the call now. Thank you for calling, and please call again any time. Goodbye."],
      ur: ["آپ کی آواز نہیں آ رہی، اس لیے کال ختم کی جا رہی ہے۔ کال کرنے کا شکریہ، آپ جب چاہیں دوبارہ کال کریں۔ خدا حافظ۔"],
    },
    // The caller asked the agent to wait ("hold on", "ek minute"), and the reply when they answer
    // "are you still there?" (voice/session.js onPause). Neither goes into the conversation.
    take_your_time: {
      en: ["Sure, take your time. I'm here.", "No problem, take your time."],
      ur: ["جی، آرام سے، کوئی جلدی نہیں۔", "کوئی بات نہیں، آرام سے دیکھ لیجیے۔"],
    },
    listening: {
      en: ["Great. Go ahead whenever you're ready.", "Okay, go ahead."],
      ur: ["جی، آپ جب چاہیں بات کریں۔", "جی، بتائیے۔"],
    },
    closing: {
      en: ["Thank you for calling. Goodbye."],
      ur: ["کال کرنے کا شکریہ۔ خدا حافظ۔"],
    },
  };
  const options = lines[kind][language === "ur" ? "ur" : "en"];
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
 *  - KEEP THE CUSTOMER'S LANGUAGE. The embedding model is multilingual and a question
 *    in one language already retrieves documents in another well (eval:real,
 *    cross_language, 100% hit@1). A rewrite that quietly translated an Urdu follow-up
 *    into English would not improve that, and would change what the customer said
 *    in a step nothing downstream can check.
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
    "- Resolve pronouns and elliptical phrasing (\"and the Pro one?\", \"what about Sundays?\", \"is that included?\", \"اور پرو والا؟\", \"aur Sunday ko?\") using the earlier conversation, so the query makes sense with no context at all.",
    "- Use ONLY words, names and facts that already appear in the conversation. Do NOT answer the question. Do NOT add prices, numbers, policies or product details that are not already there. Do NOT guess a product or plan the customer never mentioned.",
    "- Write the query in THE SAME LANGUAGE AND SCRIPT as the customer's latest message: English stays English, Urdu stays Urdu, Roman Urdu stays Roman Urdu, a mix stays a mix. Never translate it.",
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

/** Who a person is, for the model to say: "our Senior doctor, Dr Ayesha". Never a number. */
function describeContact(contact) {
  if (!contact) return "a member of our team";
  const role = contact.role?.trim();
  const name = contact.name?.trim();
  if (role && name) return `our ${role}, ${name}`;
  return role ? `our ${role}` : name;
}

/**
 * The section for this turn's HANDOFF PLAN (lib/handoff/decide.js), or null. Four outcomes; each
 * one repeats the rule that a lie is the failure to avoid: the model says a transfer is
 * happening ONLY when the system is making it happen, and never invents a wait, a time or a
 * name it was not given.
 *
 * @param {{kind: string, reason?: string, contact?: object, callback?: boolean}|null} plan
 * @param {{channel: string}} options
 * @returns {string|null}
 */
export function buildHandoffInstruction(plan, { channel }) {
  if (!plan) return null;
  switch (plan.kind) {
    case "rephrase":
      return (
        "UNDERSTANDING: you could not make out what the caller wanted, or the reference material has nothing for it. " +
        "Say so honestly in ONE short, kind sentence (do not guess or invent an answer) and ask them to put it another " +
        "way or give a little more detail. Do not mention a person or a transfer."
      );
    case "handoff": {
      const who = describeContact(plan.contact);
      const why =
        plan.reason === "asked"
          ? "The caller asked for a person."
          : plan.reason === "frustrated"
            ? "The caller feels they are not being understood: apologise briefly and sincerely, in one clause."
            : plan.reason === "topic"
              ? "This is a matter the business wants a person to handle."
              : "You could not understand or help the caller after trying.";
      // The announcement itself ("I'm connecting you to Ali, our Representative…") is added by the code
      // right after this reply (lib/handoff/announce.js) — a model asked to say it sometimes did not.
      // So the model only acknowledges, and must NOT announce, or the caller hears it twice.
      return (
        `PASSING THE CALLER ON: ${why} The caller is being connected to ${who} right now, and a fixed sentence ` +
        "telling them who they are being connected to is added automatically RIGHT AFTER your reply. So reply with " +
        "ONE short, warm sentence only — acknowledge what they asked, or apologise briefly if you could not help — and " +
        "do NOT say that you are connecting or transferring them, do NOT name the person, " +
        (channel === "voice" ? "do not say goodbye, do not ask anything, " : "do not ask anything, ") +
        "do not give a phone number, do not guess a waiting time, and do not continue with the original question."
      );
    }
    case "unavailable":
      return (
        "PASSING THE CALLER ON — NOBODY IS AVAILABLE: the caller needs a person, but the business is closed right now, so no " +
        "one can be connected. Say that politely in one sentence" +
        (plan.callback
          ? ", and offer to take their details so a team member can call them back. Do not claim anyone will call at a specific time."
          : ", and say a team member will follow up when the business opens. Do not claim anyone will call at a specific time.") +
        " Do not say you are connecting them."
      );
    case "handed_off":
      return (
        "PASSING THE CALLER ON: this conversation has already been passed to a team member. Keep every reply to one short " +
        "sentence, answer only what is simple and clearly in the reference material, and say a team member will be with them. " +
        "Do not start new requests."
      );
    default:
      return null;
  }
}


// ── TAKING A REQUEST (lib/collect) ─────────────────────────────────────────

/** Why an answer could not be used, as guidance to the model — never shown to the customer verbatim. */
const PROBLEM_GUIDANCE = {
  invalid_phone: "it is not a valid phone number (a Pakistani mobile number has eleven digits, for example 0300 1234567)",
  invalid_email: "it is not a valid email address",
  invalid_name: "it does not look like a name",
  not_a_number: "it is not a number",
  out_of_range: "it is outside what is allowed ({min} to {max})",
  not_an_option: "it is not one of the choices",
  not_yes_no: "it is not a clear yes or no",
  invalid_datetime: "the day and time could not be worked out",
  in_past: "that time has already passed",
  too_far: "that is too far ahead (more than a year)",
  closed: "the business is closed then ({day}) — say so, mention the opening hours from ABOUT THIS BUSINESS, and ask for another time",
  empty: "nothing usable was said",
  not_on_menu: "{items} is not on the menu — say we do not have it, and offer to name a few dishes that are",
  ambiguous_item: '"{said}" could be more than one dish on the menu ({options}) — ask which one',
  empty_order: "no dish from the menu was named",
  too_many_items: "an order can have at most {max} different dishes",
};

function problemSentence(problem) {
  const template = PROBLEM_GUIDANCE[problem.reason] ?? "it could not be used";
  const text = template.replace(/\{(\w+)\}/g, (_, key) => problem.vars?.[key] ?? "");
  // Part of an order was fine and is kept: only the one dish needs a word.
  if (problem.partial) return `Part of the customer's last answer for "${problem.field.label}" could not be taken: ${text}. Say so kindly in one short sentence; the rest of it IS noted.`;
  return `The customer's last answer for "${problem.field.label}" could not be used: ${text}. Say so kindly in one short sentence and ask for it again.`;
}

/** A detail as one line of the instruction. On a call, a phone number is spelled digit by digit. */
function lineText(line, { channel, language }) {
  const spoken = channel === "voice" && line.type === "phone" ? ` (say it digit by digit: ${digitsAsWords(line.display, language)})` : "";
  return `- ${line.label}: ${line.display}${spoken}`;
}

/** The sentence that says a request is already saved, once, when it was saved THIS turn. */
function savedNote(plan, channel) {
  const saved = plan.saved;
  if (!saved?.reference) return "";
  const number = channel === "voice" ? "Do not read the request number aloud unless the customer asks for it." : `Give the request number ${saved.reference}.`;
  if (saved.justSaved) {
    return `The request has just been SAVED with the request number ${saved.reference} and now waits for a team member to confirm it. Say so in one short sentence: that it is recorded and the team will confirm. ${number}`;
  }
  return `The request is already saved (number ${saved.reference}); do not announce it again.`;
}

/**
 * The section of the system instruction for this turn's REQUEST PLAN (lib/collect/engine.js
 * `advanceCollection`). Null for no plan.
 *
 * Four rules run through every state and are repeated because each one is a lie a model
 * tells otherwise: it NEVER says a request is booked, confirmed or guaranteed (a person
 * confirms — §6.11); it asks ONE thing per turn (a caller cannot answer three questions
 * at once); it keeps the customer's own wording out of its mouth ("mirroring" a misheard
 * phone number is how wrong records are made); and it answers a side question first
 * rather than ignoring it.
 *
 * @param {object|null} plan
 * @param {{channel: string}} options
 * @returns {string|null}
 */
export function buildCollectionInstruction(plan, { channel }) {
  if (!plan) return null;
  const language = plan.language === "ur" ? "ur" : "en";
  const replyName = LANGUAGE_NAMES[language];
  const never =
    "You cannot book, confirm or cancel anything yourself: a team member confirms every request, so never say it is " +
    "booked, confirmed or guaranteed.";

  if (plan.state === "idle") {
    if (!plan.offers?.length) return null;
    const list = plan.offers.map((o) => `${o.label}`).join("; ");
    const first = plan.offers.map((o) => `for ${o.label}: "${o.firstQuestion}"`).join("; ");
    // The marker is spelled out in full for each type — never a placeholder like "code" — because a
    // model copies what it is shown: a real call once read "[[START code]]" aloud.
    const markers = plan.offers.map((o) => `${markerFor(o.type)} for ${o.label}`).join(", ");
    return (
      `REQUESTS YOU CAN TAKE: ${list}. ${never} If the customer clearly wants one of these, say in one short sentence ` +
      `that you can take their details now, then ask the first question (${first}) in ${replyName}. ` +
      `Begin your reply with exactly one of these markers, copied exactly as written: ${markers}. ` +
      "The marker is removed before the customer sees or hears it. Use it only when you are about to ask the first " +
      "question of that request, never for anything else, and never mention it."
    );
  }

  // An order is the same promise with its own words: callers expect "your order is placed" and
  // a total, and neither is true until a person confirms it (§6.25).
  const orderRule =
    plan.type === "order"
      ? " Never say the order is placed, confirmed, being prepared or on its way — say it is noted and the team will confirm it. Never state a price or a total unless it is in the reference material; the team confirms the total."
      : "";
  const header = `TAKING A REQUEST — ${plan.typeLabel}. ${never}${orderRule} This is what you do THIS turn, and nothing else about the request:`;
  const lineCtx = { channel, language };

  switch (plan.state) {
    case "ask": {
      const ask = plan.ask;
      const out = [header];
      if (plan.collected?.length) out.push(`Details already collected (do not ask for these again):\n${plan.collected.map((l) => lineText(l, lineCtx)).join("\n")}`);
      if (plan.saved) out.push(savedNote(plan, channel));
      if (plan.corrected?.length) out.push(`The customer just corrected: ${plan.corrected.map((l) => l.label).join(", ")}. ${plan.updateFailed ? "The saved request could NOT be updated just now: say a team member will correct it, and do not claim it was updated." : "Say you have updated it."}`);
      if (plan.problem) out.push(problemSentence(plan.problem));
      if (plan.extractionFailed) out.push("The last answer could not be processed just now: if the customer gave you something, politely ask them to say it once more.");
      if (plan.firstAsk) out.push("This is the first question: start with a short friendly sentence saying you can take their details.");
      let task = `Ask ONLY for: ${ask.label}${ask.required ? "" : " (optional — they may say no or skip it)"}. The business's preferred wording is "${ask.question}": keep its meaning and say it naturally in ${replyName}.`;
      if (ask.have?.date) task += ` The customer already gave the day (${ask.have.date}): ask only for the time.`;
      if (ask.have?.time) task += ` The customer already gave the time (${ask.have.time}): ask only for the day.`;
      if (ask.options?.length) task += ` The choices are: ${ask.options.join(", ")}. Say them if the customer seems unsure.`;
      if (ask.menu?.length) task += ` Only dishes on the menu can be ordered; if the customer asks what there is, name a few of them, never all: ${ask.menu.join(", ")}.`;
      out.push(task);
      out.push("Ask exactly ONE question. If the customer also asked something else, answer that first in one sentence from the reference material, then ask your question.");
      return out.join("\n");
    }
    case "saved": {
      const out = [header, savedNote({ ...plan, saved: plan }, channel)];
      out.push(`Read the details back to the customer in one short, natural message and ask whether everything is correct. If something is wrong they can tell you right now and you will update it:\n${plan.lines.map((l) => lineText(l, lineCtx)).join("\n")}`);
      if (plan.corrected?.length) out.push(`The customer just corrected: ${plan.corrected.map((l) => l.label).join(", ")}. ${plan.updateFailed ? "The saved request could NOT be updated just now: say a team member will correct it, and do not claim it was updated." : "Say you have updated it."}`);
      if (plan.problem) out.push(problemSentence(plan.problem));
      if (plan.reconfirm) out.push("The customer said something else instead of answering: answer it first in one sentence from the reference material, then ask again whether the details are correct.");
      return out.join("\n");
    }
    case "closed":
      return [
        header,
        `The customer is satisfied with the details. The request (number ${plan.reference}) is already recorded and a team member will confirm it. Thank them in one short sentence${channel === "voice" ? "" : `, mention the request number ${plan.reference} once if you have not`}, and ask whether there is anything else you can help with.`,
        "Do NOT say it is booked, confirmed or guaranteed.",
      ].join("\n");
    case "withdrawn":
      return [header, `The customer withdrew their request (number ${plan.reference}) and it has been cancelled. Acknowledge that in one short sentence and offer other help.`].join("\n");
    case "update_failed":
      return [header, "The saved request could NOT be changed just now. Apologise briefly and say a team member will correct it; do not claim it was changed."].join("\n");
    case "change":
      return [
        header,
        `The customer says something in the details is wrong. Ask which one to correct. The details are:\n${plan.lines.map((l) => lineText(l, lineCtx)).join("\n")}`,
        "Ask only that, in one short sentence.",
      ].join("\n");
    case "submit_failed":
      return [header, "The request could NOT be saved just now. Apologise briefly, say a team member will follow up, and offer to try again in a moment. Do not claim it was saved."].join("\n");
    case "cancelled":
      return [header, "The customer stopped the request, and nothing was saved. Acknowledge that in one short sentence and offer other help."].join("\n");
    case "stuck":
      return [
        header,
        `You could not get a usable answer for "${plan.field.label}" after two tries, so the request was NOT saved. Apologise briefly and say a team member can follow up with them; ask if there is anything else you can help with.`,
      ].join("\n");
    default:
      return null;
  }
}

/**
 * SYSTEM INSTRUCTION for the extraction call (lib/collect/extract.js) — like the query
 * rewrite, a model call that never speaks to a customer. Its only output is a JSON object
 * of candidate values, and every one of them is judged by validate.js before it is kept.
 *
 * The rules that carry the weight: ONLY what the customer actually said (a model that
 * "helpfully" fills a phone number from an example produces a wrong record nobody can
 * see), and dates resolved against a stated clock and the opening hours (an ambiguous
 * "five o'clock" is read the way that falls inside opening hours).
 *
 * @param {object} args
 * @param {Array<object>} args.fields    the fields still missing (lib/collect/config.js typeFields)
 * @param {object} args.config           for choice options
 * @param {number} args.nowMs
 * @param {string} args.timezone
 * @param {unknown} args.hours
 * @param {"en"|"ur"} args.language
 */
export function buildExtractionInstruction({ fields, config, nowMs, timezone, hours, language }) {
  const now = zonedParts(nowMs, timezone);
  const describe = (f) => {
    const label = f.label?.en || f.label?.ur;
    if (f.type === "choice") {
      const list = f.source ? config?.[f.source] ?? [] : f.options ?? [];
      const options = list.length
        ? `answer with ONE of these ids: ${list.map((o) => `${o.id} (${[o.label?.en, o.label?.ur].filter(Boolean).join(" / ")})`).join("; ")}`
        : "free text";
      return `- ${f.id} — ${label} — ${options}`;
    }
    if (f.type === "items") {
      const menu = (f.source ? config?.[f.source] ?? [] : []).map((o) => [o.label?.en, o.label?.ur].filter(Boolean).join(" / ")).join("; ");
      return (
        `- ${f.id} — ${label} — the dishes and how many of each that the customer ordered or changed in the LATEST message only, ` +
        `written as "2 x <dish>; 1 x <dish>", using the menu's own names where the dish is on the menu: ${menu}. ` +
        'Write a dish the customer asked for that is NOT on the menu exactly as they said it. For a dish they want removed write "0 x <dish>".'
      );
    }
    const how = {
      phone: "the digits as the customer said them",
      email: "the address as said",
      number: "digits only",
      yesno: "yes or no",
      datetime: 'NOT in "values": use "date" and "time" below',
      text: "as spoken or written, in its own script",
      longtext: "a short phrase, in the customer's own words",
    }[f.type];
    return `- ${f.id} — ${label} — ${how}`;
  };
  const hasWhen = fields.some((f) => f.type === "datetime");

  const parts = [
    "You read ONE customer message and pull out details for a request form. You never speak to the customer.",
    `FORM FIELDS (return a field only if the customer gave a value for it in the latest message):\n${fields.map(describe).join("\n")}`,
    "RULES:",
    '- Output ONLY one JSON object, no other text: {"values":{"<field id>":"<value>"},"date":null,"time":null}',
    '- "values" may contain ONLY the field ids listed above, and ONLY details the customer actually gave in the latest message (or earlier in this same conversation). Leave out every field they did not give. Never guess, never invent, never copy an example.',
    "- The customer writes or speaks English, Urdu in Urdu script, Roman Urdu, or a mix. Keep names and free text exactly as given, in their own script.",
    '- When the customer says no to a field or has nothing to give, leave it out; do not write "no" or "none" as a value.',
  ];
  if (hasWhen) {
    parts.push(
      `DATES — today is ${now.dayName} ${now.date}, and the time now is ${now.time} in ${timezone || "UTC"}.`,
      'Fill "date" (YYYY-MM-DD) when the customer gave a day, and "time" (HH:MM, 24-hour) when they gave a time; leave either null when not given. Resolve relative days from today: tomorrow = کل / kal, the day after tomorrow = پرسوں / parson, today = آج / aaj, and a weekday name means its NEXT occurrence (Friday = جمعہ / Juma, Saturday = ہفتہ / Hafta, Sunday = اتوار / Itwaar).',
      `Morning = صبح / subah, noon = دوپہر / dopahar, evening = شام / shaam, night = رات / raat. "5 baje" or "at five" with no am/pm: choose the reading that falls INSIDE the opening hours (${hours ? formatHours(hours) : "not specified — assume daytime"}); if both do, use pm for 1 to 7 and am for 8 to 11.`
    );
  } else {
    parts.push('"date" and "time" are always null for this form.');
  }
  return parts.join("\n");
}

/**
 * The user turn for the extraction call.
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.history prior turns, oldest first
 * @param {string} args.message
 * @param {{label?: {en?: string}, id?: string}|null} [args.asking] the question just asked
 */
export function buildExtractionInput({ history, message, asking }) {
  const clip = (text, max = 300) => {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  const recent = (history ?? []).slice(-4);
  const transcript = recent.length ? recent.map((m) => `${m.role === "assistant" ? "Assistant" : "Customer"}: ${clip(m.content)}`).join("\n") : "(none)";
  return (
    `EARLIER IN THIS CONVERSATION:\n${transcript}\n\n` +
    `THE QUESTION JUST ASKED WAS ABOUT: ${asking ? `${asking.label?.en || asking.id} (${asking.id})` : "nothing in particular"}\n\n` +
    `LATEST CUSTOMER MESSAGE:\n${clip(message, 600)}\n\n` +
    "JSON:"
  );
}

const DAY_NAMES = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

/** The wall clock in a zone, for the extraction prompt. Mirrors lib/collect/validate.js zonedNow without importing it back. */
function zonedParts(nowMs, timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  } catch {
    return zonedParts(nowMs, "UTC");
  }
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const [y, m, d] = date.split("-").map(Number);
  const key = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { date, time: `${get("hour")}:${get("minute")}`, dayName: DAY_NAMES[key] };
}
