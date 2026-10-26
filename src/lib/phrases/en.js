/**
 * ENGLISH — the generic things a caller says that are about the BUSINESS itself, not about any
 * one product or price. Data only: the matcher is ./index.js, which also explains the syntax.
 *
 * Phrase syntax (one phrase per string, written in lower case):
 *   word          must appear, in this order, next to its neighbours
 *   a/b/c         any one of these words
 *   word?         may be missing
 *   *             any one to three words ("a little bit more", "quickly")
 *   {name}        the business's own name, as the owner typed it ("what does Pizza Roma do")
 *
 * Contractions are expanded before matching ("what's" → "what is", "you're" → "you are"), so
 * phrases are written in the long form only.
 *
 * Adding a phrase: put it in the right group, run `npm test` (tests/phrases.test.mjs checks
 * every group still matches its examples and that nothing here matches an ordinary question).
 */

/**
 * PAUSES — what a caller says about the CALL itself, not the business (voice/session.js):
 *   holdOn     "hold on, let me find my card" — the agent says "take your time" and waits longer
 *              before asking "are you still there?";
 *   stillHere  the answer to "are you still there?" — "yes, I'm here". Only read that way right
 *              after the agent has asked it; anywhere else "yes" is an answer to the conversation.
 * Neither is sent to the brain, so neither enters the conversation: the next real question
 * follows straight on from the exchange before the pause.
 */
export const PAUSES = {
  holdOn: [
    "hold on",
    "hang on",
    "one moment/second/sec/minute/min",
    "just a moment/second/sec/minute/min",
    "give me a moment/second/sec/minute/min",
    "wait a moment/second/sec/minute/min",
    // Not a bare "wait": "oh wait, one more thing" is the caller carrying on, not asking to hold.
    "bear with me",
    "let me check/find/get/look/grab",
    "let me just check/find/get/look/grab",
    "i need a moment/second/minute",
    "can you hold/wait",
    "please hold/wait",
  ],
  stillHere: [
    "yes/yeah/yep/yup",
    "i am here",
    "yes i am here",
    "i am still here",
    "still here",
    "i am on the line",
    "i am still on the line",
    "hello",
    "yes hello",
    "here",
  ],
};

/** Question words: "wait, how much is it?" asks something — it is not a request to hold. */
export const QUESTION_WORDS = ["what", "how", "when", "where", "why", "which", "who", "whats", "hows", "whose"];

/** Words that name the business itself — used inside the phrases below. */
const BUSINESS = "company/business/firm/organisation/organization/agency/clinic/practice/hospital/restaurant/cafe/shop/store/brand/office/centre/center/team/place/service/outfit/establishment/startup";

export const OPENERS = {
  // "Who am I talking to?" — the caller wants to know who answered.
  identity: [
    "who are you",
    "who are you guys",
    "who is this",
    "who is speaking",
    "who am i speaking/talking to/with",
    "who have i called/reached",
    "what is this place",
    "what is your name",
    "who is on the line",
    "have i reached the right number/place",
    "is this the right number",
  ],

  // "Tell me about your company" — an overview of the business.
  about: [
    "tell me about you/yourself/yourselves/us",
    "tell me * about you/yourself/yourselves",
    "tell me about your " + BUSINESS,
    "tell me * about your " + BUSINESS,
    "tell me about this " + BUSINESS,
    "talk me through your " + BUSINESS,
    "can you describe your " + BUSINESS,
    "describe your " + BUSINESS,
    "describe yourself/yourselves",
    "introduce yourself/yourselves/your",
    "give me a/an? overview/introduction/summary/idea",
    "give me a/an? * overview/introduction/summary",
    "a/an? overview of your " + BUSINESS,
    "overview about your " + BUSINESS,
    "what is your " + BUSINESS + " about",
    "what is your " + BUSINESS,
    "what is this " + BUSINESS,
    "what kind/type/sort of " + BUSINESS + " is this",
    "what kind/type/sort of " + BUSINESS + " are you",
    "what kind/type/sort of business do you run/have",
    "about your " + BUSINESS,
    "more about you/yourselves",
    "know more about you/yourselves/your",
    "learn more about you/yourselves/your",
    "what are you about",
    "what is {name}",
    "what is {name} all about",
    "what is this all about",
    "tell me about {name}",
    "who is/are {name}",
  ],

  // "What do you do / sell / offer?" — what the business provides.
  offerings: [
    "what do you do",
    "what do you guys do",
    "what do you people do",
    "what does your " + BUSINESS + " do",
    "what does this " + BUSINESS + " do",
    "what does {name} do",
    "what does {name} sell/offer/provide/make",
    "what do you sell/offer/provide/make/supply",
    "what do you deal in",
    "what do you guys sell/offer/provide/make",
    "what does your " + BUSINESS + " sell/offer/provide/make",
    "what services/products/solutions/treatments/packages do you offer/provide/have/sell/do",
    "what services/products/solutions/treatments/packages you offer/provide/have/sell/do",
    "what kind/type/sort of services/products/solutions/treatments/work/things you offer/provide/have/sell/do",
    "what kind/type/sort of services/products/solutions/treatments/work/things do you offer/provide/have/sell/do",
    "what are your services/products/solutions/offerings/treatments/packages",
    "what are the services/products/solutions/offerings you offer/provide/have",
    "which services/products/solutions do you offer/provide/have",
    "what services/products/solutions are available/offered",
    "what services/products/solutions are there",
    "what is it that you do",
    "what you do/sell/offer/provide/make",
    "what your " + BUSINESS + " does/do/sells/offers/provides",
    "what {name} does/do/sells/offers",
    "what line of business are you in",
    "what is your line of work/business",
    "what field are you in",
    "what do you specialise/specialize in",
    "what are you specialised/specialized in",
    "what do you have on offer",
    "what can i get/buy from you",
    "list your services/products",
  ],

  // "How can you help me?" — what the agent itself can do on this call.
  help: [
    "how can you help me/us",
    "how can you help",
    "how do you help",
    "what can you do for me/us",
    "what can you do",
    "what can you help me/us with",
    "what can you help with",
    "what can i ask you",
    "what can i ask",
    "what are you able to do",
    "how does this work",
    "what are my options",
  ],

  // "Am I talking to a robot?" — the agent must always answer this honestly (prompt.js).
  aiCheck: [
    "are you a/an? robot/bot/machine/computer/ai/human/person/recording",
    "are you real",
    "are you human",
    "are you a/an? real/actual/live person/human",
    "are you a/an? artificial intelligence",
    "am i talking/speaking to/with a/an? robot/bot/machine/computer/ai/human/person/recording",
    "am i talking/speaking to/with a/an? real/actual/live person/human",
    "is this a/an? robot/bot/machine/computer/recording",
    "is this a/an? recorded/automated message/call/system/voice",
    "is this automated",
    "is this a/an? real/actual/live person/human",
    "is this ai",
  ],
};

/**
 * Words that carry no meaning of their own in an opener ("hi, could you PLEASE tell me a bit
 * about your company"). After an opener phrase is found, a message whose other words are all in
 * this list (or the business's own name) is still a generic opener; one more real word is
 * allowed ("tell me about your company and prices" is still mostly an overview).
 */
export const FILLER = [
  "hi", "hello", "hey", "hiya", "good", "morning", "afternoon", "evening", "day",
  "please", "pls", "plz", "kindly", "thanks", "thank", "you", "cheers",
  "so", "um", "uh", "erm", "er", "ah", "oh", "ok", "okay", "right", "well", "yeah", "yes", "yep", "sure",
  "can", "could", "would", "will", "may", "might", "do", "does", "did",
  "i", "me", "my", "we", "us", "our", "your", "yours", "it", "this", "that", "there",
  "a", "an", "the", "of", "to", "for", "and", "or", "with", "about", "on", "in", "at", "is", "are", "am",
  "just", "quickly", "briefly", "little", "bit", "bits", "few", "some", "more", "all", "first", "again",
  "want", "wanted", "like", "know", "wondering", "wonder", "was", "were", "curious", "tell", "say", "explain",
  "actually", "basically", "exactly", "really", "generally", "overall", "anything", "something",
  "sir", "madam", "maam", "mate", "dear", "guys", "folks",
];

/**
 * What the greeting must SAY for the two notices (lib/voice/greeting.js). A greeting the owner
 * wrote that contains none of the `ai` words gets the "callers are not told they are speaking
 * to an AI" warning; none of the `recording` words, while recording is on, the recording one.
 */
export const NOTICE_WORDS = {
  ai: [
    "ai", "a.i", "a i", "artificial intelligence", "virtual assistant", "virtual agent", "digital assistant",
    "automated", "automatic assistant", "robot", "bot", "chatbot", "voice assistant", "not a person",
    "not a human", "machine",
  ],
  recording: ["recorded", "recording", "record", "monitored", "monitoring"],
};
