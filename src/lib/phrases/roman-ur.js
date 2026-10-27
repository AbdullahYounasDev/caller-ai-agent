/**
 * ROMAN URDU — Urdu written in English letters, the way most Pakistanis type and the way a
 * recogniser often writes Urdu speech ("aap kya karte hain", "apni company ke bare mein batao").
 * Data only; the matcher and its phrase syntax are in ./index.js and ./en.js.
 *
 * Nobody spells Roman Urdu the same way twice, so phrases are written in ONE spelling and
 * SPELLINGS lists the other ways people write each word: before matching, every word of the
 * message is turned into its listed spelling ("ap", "aap" → "aap"; "kia", "kiya" → "kya").
 * English words people mix in (company, business, services) are matched as they are. A variant
 * may be two words ("kaun si" → "kaunsi"); those are joined before the words are compared.
 */

/** canonical spelling → other ways it is written. A variant must belong to ONE word only. */
export const SPELLINGS = {
  aap: ["ap", "aapp", "app"],
  aapka: ["apka", "aapka", "apkaa", "aap ka", "ap ka"],
  aapki: ["apki", "aapki", "aap ki", "ap ki"],
  aapke: ["apke", "aapke", "apkay", "aapkay", "aap ke", "ap ke", "aap kay", "ap kay"],
  kya: ["kia", "kiya", "kyaa", "kiaa", "kea"],
  kaun: ["kon", "kaon", "koun", "kaun"],
  hain: ["hai", "hen", "hein", "hn", "hy", "he", "ho", "hey"],
  karte: ["krte", "kartay", "krtay", "karti", "krti", "kerte", "karty"],
  karta: ["krta"],
  kaam: ["kam", "kaam"],
  bare: ["baare", "baray", "baaray", "bary"],
  mein: ["me", "mai", "men", "mien", "mei", "mn"],
  batain: ["batao", "bataen", "batayein", "batayen", "bataiye", "bataye", "bataien", "batain", "btao", "btain", "btayen", "bataein", "bata", "btaen"],
  apne: ["apnay", "apny", "apnai"],
  apni: ["apnee"],
  company: ["compny", "kampni", "kampany", "companay"],
  business: ["bizness", "biznes", "bussiness", "busines", "karobar", "kaarobar"],
  services: ["service", "servises", "sarvices", "khidmat", "khidmaat", "sahuliyat", "sahooliat"],
  products: ["product", "products", "cheezein", "cheezain", "cheezen", "chizen", "cheezen"],
  dete: ["dete", "detay", "deti", "dety", "provide", "offer"],
  bechte: ["bechtay", "bechti", "bechty", "sell"],
  sakte: ["sakte", "saktay", "sakti", "sakty", "skte"],
  madad: ["madad", "mdad", "help"],
  baat: ["bat", "baat"],
  raha: ["rha", "rahi", "rhi", "rahe", "rhe"],
  hoon: ["hun", "hu", "hoo", "hon"],
  taaruf: ["taruf", "tarruf", "taaruf", "introduction", "intro"],
  karwain: ["karwayein", "karwaen", "karwao", "karayein", "karaen", "karao", "krwao", "krwain", "kraen"],
  naam: ["nam", "naam"],
  insaan: ["insan", "insaan", "inssan", "human", "bandah", "banda", "bande", "banday"],
  robot: ["robot", "robo", "bot", "machine", "computer"],
  chahta: ["chahti", "chahte", "chahtay"],
  jaanna: ["janna", "jan na", "jaanana"],
  pooch: ["puch", "pooch", "poch"],
  yeh: ["ye", "yh", "yay", "yahan"],
  kaunsi: ["konsi", "kaun si", "kon si", "konsa", "kaunsa", "kounsi"],
  paas: ["pas", "paas"],
  milta: ["milti", "milte", "milty"],
  shuba: ["shoba", "field"],
  nahi: ["nahin", "nai", "nahee", "nahein", "nhi", "nahi"],
  shukriya: ["shukria", "shukriyah", "shukrya", "shukriyaa", "shukryia"],
  kafi: ["kaafi", "kaafee"],
  ilawa: ["alawa", "ilaawa", "elawa"],
  sawal: ["sawaal", "swal", "question"],
};

const YOU = "aap/tum/tm";
const COMPANY = "company/business/clinic/restaurant/shop/store/dukaan/dukan/idara/firm/office";

export const OPENERS = {
  identity: [
    `${YOU} kaun hain`,
    `${YOU} kaun bol raha hain`,
    "kaun bol raha hain",
    "kaun baat kar raha hain",
    "main kis se baat kar raha hoon",
    "mein kis se baat kar raha hoon",
    "kis se baat ho raha hain",
    "meri baat kis se ho raha hain",
    "aapka naam kya hain",
    "tumhara naam kya hain",
    "yeh kaunsi jagah hain",
    "kya yeh sahi number hain",
  ],

  about: [
    "apne bare mein batain",
    "apne bare mein kuch batain",
    "apne bare mein thora/thoda batain",
    `apni ${COMPANY} ke bare mein batain`,
    `apni ${COMPANY} ke bare mein kuch batain`,
    `apne ${COMPANY} ke bare mein batain`,
    `aapki ${COMPANY} ke bare mein batain`,
    `aapki ${COMPANY} ke bare mein`,
    `aapke ${COMPANY} ke bare mein batain`,
    `aapke bare mein batain`,
    `aapke bare mein jaanna hain/chahta`,
    `aapki ${COMPANY} kya hain`,
    `yeh kya ${COMPANY} hain`,
    `yeh kaunsi ${COMPANY} hain`,
    `yeh kis qisam ki ${COMPANY} hain`,
    "apna taaruf karwain/dein/den",
    "taaruf karwain",
    `aapka taaruf`,
    "{name} kya hain",
    "{name} ke bare mein batain",
  ],

  offerings: [
    `${YOU} kya karte hain`,
    `${YOU} log kya karte hain`,
    "aapka kaam kya hain",
    `${YOU} kya kaam karte hain`,
    `aapki ${COMPANY} kya karte/karta hain`,
    `aapka ${COMPANY} kya karta hain`,
    "{name} kya karte/karta hain",
    `${YOU} kya bechte hain`,
    `${YOU} kya services/products dete hain`,
    `${YOU} kya kya services/products dete hain`,
    `${YOU} kaunsi services/products dete hain`,
    "aapki services/products kya hain",
    "aapki kya kya services/products hain",
    "aapke paas kya kya hain",
    "aapke paas kya milta hain",
    `${YOU} kis cheez ka kaam/business karte hain`,
    "kis cheez ka business/kaam hain",
    `${YOU} kis shuba mein hain`,
  ],

  help: [
    `${YOU} meri kya madad kar sakte hain`,
    `${YOU} kya madad kar sakte hain`,
    `${YOU} kya kar sakte hain`,
    `${YOU} mere liye kya kar sakte hain`,
    "main aap se kya pooch sakta/sakti/sakte hoon",
    "mein aap se kya pooch sakta/sakti/sakte hoon",
    "yeh kaise kaam karta hain",
  ],

  aiCheck: [
    `kya ${YOU} robot/insaan/ai hain`,
    `${YOU} robot/insaan/ai hain`,
    `kya ${YOU} asli/real insaan hain`,
    "kya main kisi insaan se baat kar raha hoon",
    "kya mein kisi insaan se baat kar raha hoon",
    "kya main robot se baat kar raha hoon",
    "kya yeh robot/recording hain",
    "kya yeh automatic/automated call hain",
  ],
};

/** PAUSES — what a caller says about the call itself (see en.js PAUSES), in canonical spelling. */
export const PAUSES = {
  holdOn: [
    "ek/aik minute/mint/second/sec/lamha",
    "zara ek/aik minute/mint/second/sec/lamha",
    "ruko/rukain/rukiye/rukein/rukien/rukye",
    "zara ruko/rukain/rukiye/rukein",
    "intezar karein/karen/karo/kijiye",
    "main dekhta/dekhti hoon",
    "main check karta/karti hoon",
  ],
  stillHere: [
    "ji/jee",
    "haan/han",
    "ji haan/han",
    "haan/han ji",
    "main hoon",
    "main yahin hoon",
    "main line par hoon",
    "hello",
    "ji/jee hello",
  ],
};

/** Question words (see en.js QUESTION_WORDS), in canonical spelling. */
export const QUESTION_WORDS = ["kya", "kitna", "kitni", "kitne", "kab", "kahan", "kyun", "kaun", "kaise", "kaunsi"];

/** CLOSINGS — how a conversation comes to its end (see en.js CLOSINGS), in canonical spelling. */
export const CLOSINGS = {
  anythingElse: [
    "aur kuch",
    "kuch aur",
    "koi aur sawal/baat/kaam/madad/cheez",
    "aur koi sawal/baat/kaam/madad/cheez",
    "is ke ilawa",
  ],
  declineMore: [
    "nahi",
    "ji nahi",
    "nahi ji",
    "nahi shukriya",
    "bas",
    "bas yehi",
    "bas itna hi",
    "bas kafi hai",
    "kuch nahi",
    "aur kuch nahi",
    "nahi bas",
  ],
  farewell: [
    "khuda hafiz",
    "allah hafiz",
    "fi amanillah",
    "call karne ka shukriya",
  ],
};

/** Words with no meaning of their own in a "no, that's all" (see en.js CLOSING_FILLER), in canonical spelling. */
export const CLOSING_FILLER = [
  "nahi", "bas", "ji", "jee", "shukriya", "bohat", "bahut", "aap", "ka", "ki", "hai", "hain", "theek", "acha", "achha", "sir", "janab",
  "meherbani", "haan", "aur", "bhai", "sahab", "sahib", "baji", "thanks", "thank", "you", "ok", "okay", "khuda", "hafiz", "allah", "sab",
];

/** Words with no meaning of their own in an opener (see en.js FILLER), in their canonical spelling. */
export const FILLER = [
  "ji", "jee", "janab", "hello", "hi", "salam", "assalam", "asalam", "alaikum", "alaikum", "walaikum", "aoa",
  "please", "plz", "meherbani", "shukriya", "zara", "thora", "thoda", "thori", "kuch", "aur", "bhi", "ya",
  "mujhe", "hamein", "humein", "main", "hum", "aap", "tum", "yeh", "woh", "kya", "hain", "to", "toh", "na", "ke", "se", "ko", "ka", "ki", "keh", "kay",
  "bhai", "behen", "sahab", "sahib", "sir", "madam", "baji", "jaan", "acha", "achha", "theek", "thik", "haan", "han",
  "jaanna", "chahta", "chahiye", "tha", "thi", "pehle", "bas", "waise", "asal", "mein", "sab", "poora", "puri",
];

/** What the greeting must say for the two notices (see en.js NOTICE_WORDS). */
export const NOTICE_WORDS = {
  ai: ["ai", "masnoi zehanat", "artificial", "robot", "virtual", "automatic", "insaan nahi", "computer"],
  recording: ["record", "recording", "recorded", "record ki ja", "record ho"],
};
