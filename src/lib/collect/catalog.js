/**
 * THE CATALOGUE OF WHAT AN AGENT CAN COLLECT — pure data, no I/O, no Node APIs.
 *
 * Imported by the engine (which questions to ask, how to check an answer), by
 * PUT /api/collect (what a business may choose) and by the console (the checklist a
 * business owner ticks). One list, so the three can never disagree about what exists.
 *
 * WHY DATA AND NOT CODE: businesses differ — a dental clinic needs a service and a
 * time, a restaurant a party size, a call centre a reason and a company — and the next
 * one will differ again. Nothing here is "the dental flow": there are FIELDS (what one
 * piece of information is, how it is asked and checked), RECORD TYPES (which fields make
 * one kind of request) and INDUSTRY PRESETS (a sensible starting selection). Adding a
 * business type is adding a preset below, never a new code path. A business then adjusts
 * the preset with checkboxes (src/app/collect/CollectPanel.js).
 *
 * BOTH LANGUAGES, ALWAYS. Every label and question exists in English and Urdu, because
 * the agent asks in the business's reply language (§7) and the owner reads the checklist
 * in the interface language. A question is the business's PREFERRED wording: the model
 * keeps its meaning and may adapt the tone (prompt.js).
 */

/** The languages a label or a question exists in. Same two as everywhere else (§7). */
export const COLLECT_LANGUAGES = ["en", "ur"];

/**
 * What a piece of information IS — decides how an answer is checked (validate.js) and
 * which input the owner gets when defining a custom field.
 *   text      a short phrase (a name, a city)
 *   longtext  a sentence or two (a reason, an address)
 *   phone     a phone number, stored in international form (+923001234567)
 *   email     an email address
 *   number    a whole number within a range
 *   datetime  a date and a time, in the business's time zone, checked against opening hours
 *   choice    one entry of a list the business defines (its services, its staff)
 *   yesno     yes or no
 *   items     dishes from the business's MENU, each with a quantity (an order — order.js)
 */
export const FIELD_TYPES = ["text", "longtext", "phone", "email", "number", "datetime", "choice", "yesno", "items"];

/** Field types an owner may use for a CUSTOM field (phone/email/datetime have fixed meanings). */
export const CUSTOM_FIELD_TYPES = ["text", "longtext", "number", "choice", "yesno"];

/** The lists a `choice` (or `items`) field can draw its options from. */
export const CHOICE_SOURCES = ["services", "staff", "menu"];

/**
 * @typedef {object} FieldDef
 * @property {string} id
 * @property {"text"|"longtext"|"phone"|"email"|"number"|"datetime"|"choice"|"yesno"} type
 * @property {"identity"|"visit"|"place"|"other"} group     where the checklist files it
 * @property {"normal"|"sensitive"} sensitivity             sensitive = off by default, flagged in the console
 * @property {{en: string, ur: string}} label
 * @property {{en: string, ur: string}} question
 * @property {"services"|"staff"|"menu"} [source]           for `choice` / `items`: which owner-defined list
 * @property {Array<{id: string, label: {en: string, ur: string}, also?: string[]}>} [options]
 *                                                          for a `choice` with a FIXED list (pickup / delivery);
 *                                                          `also` = other ways callers say it
 * @property {number} [min]                                 for `number`
 * @property {number} [max]                                 for `number` (and the length of text)
 */

/** @type {FieldDef[]} */
export const FIELDS = [
  {
    id: "name",
    type: "text",
    group: "identity",
    sensitivity: "normal",
    max: 80,
    label: { en: "Name", ur: "نام" },
    question: { en: "May I have your name, please?", ur: "براہِ کرم اپنا نام بتائیں۔" },
  },
  {
    id: "phone",
    type: "phone",
    group: "identity",
    sensitivity: "normal",
    label: { en: "Phone number", ur: "فون نمبر" },
    question: {
      en: "What is the best phone number to reach you on?",
      ur: "آپ کا فون نمبر کیا ہے جس پر ہم آپ سے رابطہ کر سکیں؟",
    },
  },
  {
    id: "email",
    type: "email",
    group: "identity",
    sensitivity: "normal",
    label: { en: "Email address", ur: "ای میل ایڈریس" },
    question: { en: "What is your email address?", ur: "آپ کا ای میل ایڈریس کیا ہے؟" },
  },
  {
    id: "age",
    type: "number",
    group: "identity",
    sensitivity: "sensitive",
    min: 0,
    max: 120,
    label: { en: "Age", ur: "عمر" },
    question: { en: "May I ask your age?", ur: "کیا میں آپ کی عمر پوچھ سکتا ہوں؟" },
  },
  {
    id: "company",
    type: "text",
    group: "identity",
    sensitivity: "normal",
    max: 120,
    label: { en: "Company", ur: "کمپنی" },
    question: { en: "Which company are you calling from?", ur: "آپ کس کمپنی سے بات کر رہے ہیں؟" },
  },
  {
    id: "service",
    type: "choice",
    source: "services",
    group: "visit",
    sensitivity: "normal",
    max: 120,
    label: { en: "Service", ur: "خدمت" },
    question: { en: "Which service do you need?", ur: "آپ کو کون سی خدمت درکار ہے؟" },
  },
  {
    id: "staff",
    type: "choice",
    source: "staff",
    group: "visit",
    sensitivity: "normal",
    max: 120,
    label: { en: "Doctor or staff member", ur: "ڈاکٹر یا عملے کا فرد" },
    question: {
      en: "Would you like to see a particular doctor or staff member?",
      ur: "کیا آپ کسی خاص ڈاکٹر یا عملے کے فرد سے ملنا چاہیں گے؟",
    },
  },
  {
    id: "datetime",
    type: "datetime",
    group: "visit",
    sensitivity: "normal",
    label: { en: "Preferred date and time", ur: "ترجیحی تاریخ اور وقت" },
    question: { en: "What day and time would suit you?", ur: "آپ کو کون سا دن اور وقت مناسب رہے گا؟" },
  },
  {
    id: "party_size",
    type: "number",
    group: "visit",
    sensitivity: "normal",
    min: 1,
    max: 50,
    label: { en: "Number of people", ur: "افراد کی تعداد" },
    question: { en: "How many people will be coming?", ur: "کتنے افراد آئیں گے؟" },
  },
  {
    id: "reason",
    type: "longtext",
    group: "visit",
    sensitivity: "normal",
    max: 500,
    label: { en: "Reason", ur: "وجہ" },
    question: { en: "What is it regarding?", ur: "یہ کس سلسلے میں ہے؟" },
  },
  {
    id: "order_items",
    type: "items",
    source: "menu",
    group: "visit",
    sensitivity: "normal",
    // Lines in one order (order.js ORDER_LIMITS).
    max: 20,
    label: { en: "Order", ur: "آرڈر" },
    question: { en: "What would you like to order?", ur: "آپ کیا آرڈر کرنا چاہیں گے؟" },
  },
  {
    id: "order_type",
    type: "choice",
    group: "visit",
    sensitivity: "normal",
    max: 40,
    label: { en: "Pickup or delivery", ur: "پک اپ یا ڈیلیوری" },
    question: {
      en: "Will you pick it up, or would you like it delivered?",
      ur: "آپ خود لے جائیں گے یا ڈیلیوری چاہیے؟",
    },
    // A fixed list (no owner list to draw from), with the ways callers actually say each one.
    options: [
      {
        id: "pickup",
        label: { en: "Pickup", ur: "پک اپ" },
        also: ["pick up", "pickup", "pick it up", "picking up", "pick", "takeaway", "take away", "collect", "collection", "come and get", "khud", "le jaunga", "le jaungi", "le jayenge", "le jayen", "خود", "لے جاؤں", "لے جائیں", "لے جاؤں گا", "لے جاؤں گی", "ٹیک اوے"],
      },
      {
        id: "delivery",
        label: { en: "Delivery", ur: "ڈیلیوری" },
        also: ["deliver", "delivered", "delivery", "home delivery", "bring it", "send it", "bhej", "bhejein", "bhej dein", "ghar", "ghar pe", "ghar par", "بھیج", "گھر", "ڈیلیور", "ڈیلیوری"],
      },
    ],
  },
  {
    id: "order_time",
    type: "text",
    group: "visit",
    sensitivity: "normal",
    max: 80,
    label: { en: "Preferred time", ur: "ترجیحی وقت" },
    question: {
      en: "When would you like it — as soon as possible, or at a particular time?",
      ur: "آپ کو کب چاہیے — جتنی جلدی ہو سکے، یا کسی خاص وقت پر؟",
    },
  },
  {
    id: "callback_window",
    type: "text",
    group: "visit",
    sensitivity: "normal",
    max: 120,
    label: { en: "Best time to call back", ur: "واپس کال کا مناسب وقت" },
    question: { en: "When is a good time for us to call you back?", ur: "ہم آپ کو واپس کال کب کر سکتے ہیں؟" },
  },
  {
    id: "reference",
    type: "text",
    group: "other",
    sensitivity: "normal",
    max: 60,
    label: { en: "Reference or order number", ur: "حوالہ یا آرڈر نمبر" },
    question: {
      en: "Do you have a reference or order number?",
      ur: "کیا آپ کے پاس کوئی حوالہ یا آرڈر نمبر ہے؟",
    },
  },
  {
    id: "address",
    type: "longtext",
    group: "place",
    sensitivity: "normal",
    max: 300,
    label: { en: "Address", ur: "پتہ" },
    question: { en: "What is your address?", ur: "آپ کا پتہ کیا ہے؟" },
  },
  {
    id: "city",
    type: "text",
    group: "place",
    sensitivity: "normal",
    max: 80,
    label: { en: "City", ur: "شہر" },
    question: { en: "Which city are you in?", ur: "آپ کس شہر میں ہیں؟" },
  },
  {
    id: "notes",
    type: "longtext",
    group: "other",
    sensitivity: "normal",
    max: 500,
    label: { en: "Anything else", ur: "کوئی اور بات" },
    question: {
      en: "Is there anything else we should know?",
      ur: "کیا کوئی اور بات ہے جو ہمیں معلوم ہونی چاہیے؟",
    },
  },
];

const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

/** @param {string} id @returns {FieldDef|null} */
export function getField(id) {
  return FIELD_BY_ID.get(id) ?? null;
}

/** The checklist groups, in the order the console shows them. */
export const FIELD_GROUPS = ["identity", "visit", "place", "other"];

/**
 * @typedef {object} RecordTypeDef
 * @property {string} id
 * @property {{en: string, ur: string}} label
 * @property {{en: string, ur: string}} description   one line for the owner
 * @property {boolean} scheduled     it is about a point in time: needs the `datetime` field
 * @property {string[]} mustReach    at least one of these fields must be collected, or the team cannot reach the customer
 * @property {string[]} mustInclude  fields that cannot be left out
 * @property {string} [needsList]    a list the business must fill in before the agent takes this ("menu"); until
 *                                   then the type is not offered (config.js enabledRecordTypes) and the console warns
 */

/** @type {RecordTypeDef[]} */
export const RECORD_TYPES = [
  {
    id: "appointment",
    label: { en: "Appointment request", ur: "اپائنٹمنٹ کی درخواست" },
    description: {
      en: "A customer asks for a time. Your team confirms it; the agent never says it is booked.",
      ur: "گاہک ایک وقت مانگتا ہے۔ آپ کی ٹیم تصدیق کرتی ہے؛ ایجنٹ کبھی نہیں کہتا کہ بکنگ ہو گئی۔",
    },
    scheduled: true,
    mustReach: ["phone", "email"],
    mustInclude: ["datetime"],
  },
  {
    id: "callback",
    label: { en: "Callback request", ur: "واپس کال کی درخواست" },
    description: {
      en: "A customer asks to be called back. Your team calls them.",
      ur: "گاہک واپس کال کی درخواست کرتا ہے۔ آپ کی ٹیم انہیں کال کرتی ہے۔",
    },
    scheduled: false,
    mustReach: ["phone"],
    mustInclude: ["phone"],
  },
  {
    id: "order",
    label: { en: "Order request", ur: "آرڈر کی درخواست" },
    description: {
      en: "A customer orders from your menu, for pickup or delivery. Your team confirms the order and the total; the agent never says the order is placed.",
      ur: "گاہک آپ کے مینو سے پک اپ یا ڈیلیوری کے لیے آرڈر دیتا ہے۔ آپ کی ٹیم آرڈر اور کل رقم کی تصدیق کرتی ہے؛ ایجنٹ کبھی نہیں کہتا کہ آرڈر ہو گیا۔",
    },
    scheduled: false,
    mustReach: ["phone"],
    mustInclude: ["phone", "order_items"],
    // Only dishes on the menu can be ordered: no menu, nothing to order from.
    needsList: "menu",
  },
];

const RECORD_TYPE_BY_ID = new Map(RECORD_TYPES.map((r) => [r.id, r]));

/** @param {string} id @returns {RecordTypeDef|null} */
export function getRecordType(id) {
  return RECORD_TYPE_BY_ID.get(id) ?? null;
}

/**
 * @typedef {object} PresetType
 * @property {boolean} enabled
 * @property {Array<{id: string, required: boolean, question?: {en: string, ur: string}, when?: {field: string, equals: string}}>} fields
 *   in the order they are asked; `when` = asked only when an earlier answer is that (the address, only for delivery)
 * @property {{en: string, ur: string}} [label]               what this business calls it ("Table reservation")
 */

/**
 * @typedef {object} IndustryPreset
 * @property {string} id
 * @property {{en: string, ur: string}} label
 * @property {Record<string, PresetType>} recordTypes
 * @property {Array<{en: string, ur: string}>} [suggestedServices]
 */

const f = (id, required = true, extra = {}) => ({ id, required, ...extra });

/** A food order: what, how many, pickup or delivery, the address only for delivery. */
const ORDER_FIELDS = [
  f("name"),
  f("phone"),
  f("order_items"),
  f("order_type"),
  f("address", true, {
    question: { en: "What is the delivery address?", ur: "ڈیلیوری کا پتہ کیا ہے؟" },
    when: { field: "order_type", equals: "delivery" },
  }),
  // One open question instead of two (time, then instructions): six questions is already a long
  // call. An owner who wants the time on its own adds the "Preferred time" field.
  f("notes", false, {
    question: {
      en: "Anything we should know — when you'd like it, the spice level, or an allergy?",
      ur: "کوئی خاص بات — آپ کو کب چاہیے، مرچ کتنی ہو، یا کسی چیز سے الرجی؟",
    },
  }),
];

/** @type {IndustryPreset[]} */
export const INDUSTRIES = [
  {
    id: "general",
    label: { en: "General business", ur: "عام کاروبار" },
    recordTypes: {
      appointment: { enabled: true, fields: [f("name"), f("phone"), f("datetime"), f("reason", false)] },
      callback: { enabled: true, fields: [f("name"), f("phone"), f("reason", false), f("callback_window", false)] },
      // Off everywhere but the restaurant preset; here so every business can switch it on.
      order: { enabled: false, fields: ORDER_FIELDS },
    },
  },
  {
    id: "dental",
    label: { en: "Dental clinic", ur: "ڈینٹل کلینک" },
    recordTypes: {
      appointment: { enabled: true, fields: [f("name"), f("phone"), f("service"), f("datetime"), f("notes", false)] },
      callback: { enabled: true, fields: [f("name"), f("phone"), f("reason", false)] },
    },
    suggestedServices: [
      { en: "Checkup", ur: "معائنہ" },
      { en: "Scaling and polishing", ur: "صفائی اور پالش" },
      { en: "Filling", ur: "فلنگ" },
      { en: "Root canal", ur: "روٹ کینال" },
      { en: "Tooth extraction", ur: "دانت نکلوانا" },
      { en: "Braces", ur: "بریسز" },
      { en: "Teeth whitening", ur: "دانتوں کی وائٹننگ" },
    ],
  },
  {
    id: "clinic",
    label: { en: "Medical clinic", ur: "طبی کلینک" },
    recordTypes: {
      appointment: { enabled: true, fields: [f("name"), f("phone"), f("staff", false), f("datetime"), f("reason")] },
      callback: { enabled: true, fields: [f("name"), f("phone"), f("reason", false)] },
    },
    suggestedServices: [
      { en: "General checkup", ur: "عمومی معائنہ" },
      { en: "Follow-up visit", ur: "فالو اپ وزٹ" },
      { en: "Lab test", ur: "لیب ٹیسٹ" },
      { en: "Vaccination", ur: "ویکسینیشن" },
    ],
  },
  {
    id: "salon",
    label: { en: "Barber or salon", ur: "باربر یا سیلون" },
    recordTypes: {
      appointment: { enabled: true, fields: [f("name"), f("phone"), f("service"), f("staff", false), f("datetime")] },
      callback: { enabled: true, fields: [f("name"), f("phone")] },
    },
    suggestedServices: [
      { en: "Haircut", ur: "ہیئر کٹ" },
      { en: "Beard trim", ur: "داڑھی کی تراش" },
      { en: "Facial", ur: "فیشل" },
      { en: "Hair colour", ur: "ہیئر کلر" },
      { en: "Bridal makeup", ur: "برائیڈل میک اپ" },
    ],
  },
  {
    id: "restaurant",
    label: { en: "Restaurant or food", ur: "ریسٹورنٹ یا کھانے کا کاروبار" },
    recordTypes: {
      appointment: {
        enabled: true,
        label: { en: "Table reservation", ur: "میز کی بکنگ" },
        fields: [f("name"), f("phone"), f("party_size"), f("datetime"), f("notes", false)],
      },
      callback: { enabled: true, fields: [f("name"), f("phone"), f("reason", false)] },
      order: { enabled: true, fields: ORDER_FIELDS },
    },
  },
  {
    id: "call_center",
    label: { en: "Call centre", ur: "کال سینٹر" },
    recordTypes: {
      appointment: { enabled: false, fields: [f("name"), f("phone"), f("datetime")] },
      callback: {
        enabled: true,
        fields: [f("name"), f("phone"), f("company", false), f("reason"), f("callback_window", false), f("reference", false)],
      },
    },
  },
];

const INDUSTRY_BY_ID = new Map(INDUSTRIES.map((i) => [i.id, i]));

/** @param {string} id @returns {IndustryPreset|null} */
export function getIndustry(id) {
  return INDUSTRY_BY_ID.get(id) ?? null;
}

/** Limits that keep a configuration sane and a phone call short. */
export const LIMITS = {
  /** Every extra question costs a caller's patience; past this the console warns. */
  fieldsWarnAt: 6,
  /** Hard cap per record type. */
  fieldsMax: 12,
  customFieldsMax: 10,
  /** services / staff entries */
  listMax: 60,
  /** dishes on a menu */
  menuMax: 150,
  /** options of a custom choice field */
  optionsMax: 30,
  labelMax: 80,
  questionMax: 240,
};

/** The text of a `{en, ur}` pair in one language, falling back to the other, then "". */
export function pick(pair, language) {
  if (!pair || typeof pair !== "object") return "";
  return pair[language] || pair.en || pair.ur || "";
}
