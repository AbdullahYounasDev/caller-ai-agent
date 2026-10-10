/**
 * THE LABELLED QUESTION SET shared by the retrieval evals — one copy, so the
 * eval that gates the pipeline (eval-retrieval-real.mjs) and the one that picks
 * an embedding scheme (eval-embedding-variants.mjs) can never score different
 * questions. See the notes on `expect`/`expectAny`/`expectBoth`/`history` below.
 */

export const U = (text) => ({ role: "user", text });
export const A = (text) => ({ role: "assistant", text });

/**
 * THE LABELLED QUESTION SET (94 items: 71 standalone, 23 with a conversation).
 *
 *   expect      one correct source document
 *   expectAny   several sources genuinely both correct (the corpus restates
 *               the same fact in more than one document — e.g. ClinicHMS
 *               practitioner counts appear in both the pricing PDF and the
 *               FAQ). Any one of them counts as a hit.
 *   expectBoth  a CONFLICT question — both sources must appear, because the
 *               correct behaviour is surfacing the disagreement (§6.10), not
 *               picking one.
 *   history     the conversation BEFORE this message. Only the follow-up
 *               categories carry one; those are searched through
 *               POST /api/knowledge/search (retrieveForTurn, the conversation-
 *               aware path respond() uses) instead of the single-message GET.
 *               Scored under whichever strategy --strategy= selects (§6.19).
 *
 * A NOTE ON CROSS-LANGUAGE PURITY: this fixture set has no fact that exists
 * ONLY in the Italian FAQ (11) with no English restatement elsewhere — every
 * fact in it is also covered by an English document. Most `cross_language`
 * items below therefore use `expectAny` including both the Italian doc and
 * its English counterpart, which is an honest reflection of the corpus, not
 * a design flaw in the eval — except the StorePulse questions (11 has no
 * StorePulse content at all), which ARE a clean, uncontaminated cross-lingual
 * test.
 */
export const QUESTIONS = [
  // ── FACTUAL — direct, clearly worded (24) ─────────────────────────────
  { q: "How much is the ClinicHMS Starter plan?", category: "factual", expect: "02-clinichms-pricing.pdf" },
  { q: "How much is the ClinicHMS Growth plan?", category: "factual", expect: "02-clinichms-pricing.pdf" },
  { q: "What is included in the ClinicHMS Enterprise plan?", category: "factual", expect: "02-clinichms-pricing.pdf" },
  { q: "How much is the ClinicHMS telemedicine add-on?", category: "factual", expect: "02-clinichms-pricing.pdf" },
  { q: "How many practitioners can the ClinicHMS Growth plan support?", category: "factual", expectAny: ["02-clinichms-pricing.pdf", "06-clinichms-faq.md"] },
  { q: "Does ClinicHMS include a pharmacy module on the Starter plan?", category: "factual", expect: "06-clinichms-faq.md" },
  { q: "How are appointment reminders sent in ClinicHMS?", category: "factual", expect: "06-clinichms-faq.md" },
  { q: "Can Nyron import our existing patient data when we sign up for ClinicHMS?", category: "factual", expect: "06-clinichms-faq.md" },
  { q: "How much is the StorePulse Lite plan?", category: "factual", expectAny: ["03-storepulse-pricing-plans.docx", "12-storepulse-plans.csv"] },
  { q: "How much is the barcode and label printing add-on for StorePulse?", category: "factual", expect: "03-storepulse-pricing-plans.docx" },
  { q: "How much is the StorePulse supplier portal add-on?", category: "factual", expect: "03-storepulse-pricing-plans.docx" },
  { q: "What does the StorePulse onboarding process look like?", category: "factual", expect: "07-storepulse-user-guide.pdf" },
  { q: "How do I import my product catalog into StorePulse?", category: "factual", expect: "07-storepulse-user-guide.pdf" },
  { q: "What happens when a product's stock runs low in StorePulse?", category: "factual", expect: "07-storepulse-user-guide.pdf" },
  { q: "How does StorePulse's end of day reconciliation work?", category: "factual", expect: "07-storepulse-user-guide.pdf" },
  { q: "What are your support hours for the Enterprise plan?", category: "factual", expect: "05-availability-and-support-hours.md" },
  { q: "What is your uptime guarantee for the Growth plan?", category: "factual", expect: "05-availability-and-support-hours.md" },
  { q: "Which regions do you operate in?", category: "factual", expect: "05-availability-and-support-hours.md" },
  { q: "Is support available on public holidays?", category: "factual", expect: "05-availability-and-support-hours.md" },
  { q: "Can I get a refund if I cancel my annual subscription?", category: "factual", expectAny: ["04-returns-and-refund-policy.txt", "11-clinichms-faq-it.md"] },
  { q: "What happens if I upgrade my plan partway through the month?", category: "factual", expect: "04-returns-and-refund-policy.txt" },
  { q: "Can I return a barcode scanner I bought from you?", category: "factual", expect: "04-returns-and-refund-policy.txt" },
  { q: "How long is my data kept after I cancel my account?", category: "factual", expectAny: ["04-returns-and-refund-policy.txt", "06-clinichms-faq.md"] },
  { q: "What's your ragù recipe?", category: "factual", expect: "09-off-topic-recipe.txt" },

  // ── PHRASED LOOSELY — same facts, natural phone-caller wording (11) ───
  { q: "what's the cheapest option for a small clinic", category: "phrased_loosely", expect: "02-clinichms-pricing.pdf" },
  { q: "do you guys do refunds if I cancel early", category: "phrased_loosely", expect: "04-returns-and-refund-policy.txt" },
  { q: "what time is your support open on weekends", category: "phrased_loosely", expect: "05-availability-and-support-hours.md" },
  { q: "how many days do I have to send back hardware I don't want", category: "phrased_loosely", expect: "04-returns-and-refund-policy.txt" },
  { q: "is my info still there if I cancel and come back later", category: "phrased_loosely", expectAny: ["04-returns-and-refund-policy.txt", "06-clinichms-faq.md"] },
  { q: "what's this new connect thing you're building", category: "phrased_loosely", expect: "01-company-overview.md" },
  { q: "what's your clinic software called", category: "phrased_loosely", expect: "01-company-overview.md" },
  { q: "can I use this on more than one shop location", category: "phrased_loosely", expectAny: ["03-storepulse-pricing-plans.docx", "07-storepulse-user-guide.pdf"] },
  { q: "whats included when I sign up as an enterprise customer for the clinic one", category: "phrased_loosely", expect: "02-clinichms-pricing.pdf" },
  { q: "do you have a number I can call", category: "phrased_loosely", expectAny: ["01-company-overview.md", "04-returns-and-refund-policy.txt", "10-nyron-onboarding-scanned.pdf"] },
  { q: "what happens to my stuff if I stop paying", category: "phrased_loosely", expectAny: ["04-returns-and-refund-policy.txt", "06-clinichms-faq.md"] },

  // ── CROSS LANGUAGE (10) ────────────────────────────────────────────────
  { q: "Quanto costa il piano ClinicHMS Growth?", category: "cross_language", expectAny: ["02-clinichms-pricing.pdf", "11-clinichms-faq-it.md"] },
  { q: "Avete un periodo di prova gratuito per ClinicHMS?", category: "cross_language", expectAny: ["02-clinichms-pricing.pdf", "04-returns-and-refund-policy.txt", "11-clinichms-faq-it.md"] },
  { q: "Qual è la vostra politica di rimborso per gli abbonamenti annuali?", category: "cross_language", expectAny: ["04-returns-and-refund-policy.txt", "11-clinichms-faq-it.md"] },
  { q: "Dove si trovano i vostri data center?", category: "cross_language", expectAny: ["05-availability-and-support-hours.md", "11-clinichms-faq-it.md"] },
  { q: "Quanti negozi supporta il piano StorePulse Pro?", category: "cross_language", expectAny: ["03-storepulse-pricing-plans.docx", "08-storepulse-price-list-conflict.txt", "12-storepulse-plans.csv"] },
  { q: "Qual è la vostra ricetta del ragù?", category: "cross_language", expect: "09-off-topic-recipe.txt" },
  { q: "Quali sono gli orari di supporto per il piano Enterprise?", category: "cross_language", expectAny: ["05-availability-and-support-hours.md", "11-clinichms-faq-it.md"] },
  { q: "How much is ClinicHMS Growth in euros per month?", category: "cross_language", expectAny: ["02-clinichms-pricing.pdf", "11-clinichms-faq-it.md"] },
  { q: "Is ClinicHMS data stored in Europe?", category: "cross_language", expectAny: ["05-availability-and-support-hours.md", "11-clinichms-faq-it.md"] },
  { q: "What is the cancellation policy for annual plans?", category: "cross_language", expectAny: ["04-returns-and-refund-policy.txt", "11-clinichms-faq-it.md"] },

  // ── OFF TOPIC — must return NOTHING (8) ───────────────────────────────
  { q: "What is the capital of France?", category: "off_topic" },
  { q: "Can you help me renew my car insurance?", category: "off_topic" },
  { q: "What are your flight change fees?", category: "off_topic" },
  { q: "How do I reset my email password?", category: "off_topic" },
  { q: "Do you sell mobile phone contracts?", category: "off_topic" },
  { q: "What's the weather like in Milan today?", category: "off_topic" },
  { q: "Can you help me file my taxes?", category: "off_topic" },
  { q: "Do you have any job openings?", category: "off_topic" },

  // ── GENERIC OVERVIEW — known weak spot (§6.3, TEST-REPORT.md) (8) ─────
  { q: "tell me about your company", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "what do you do", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "who are you", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "what services do you provide", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "give me an overview of your company", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "what type of services you provide", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "who are you and what do you sell", category: "generic_overview", expect: "01-company-overview.md" },
  { q: "can you tell me what your business does", category: "generic_overview", expect: "01-company-overview.md" },

  // ── REPORT PHRASINGS — the seven natural overview openers from TEST-REPORT.md §4 (7) ──
  // Kept as their own category (not folded into generic_overview) so the exact
  // table in that report can be re-read after any change that moves distances:
  // three phrasings pass today, four are declined by under 0.04 (§6.20). Excluded
  // from "overall" like follow-ups, so earlier baselines stay comparable.
  { q: "what type of services you provide", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "what products do you offer", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "give me overview about your company", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "tell me about your company", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "what does nyron do", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "who are you and what do you sell", category: "report_phrasings", expect: "01-company-overview.md" },
  { q: "what is nyron about", category: "report_phrasings", expect: "01-company-overview.md" },

  // ── CONFLICT — BOTH sources must appear (§6.10) (3) ───────────────────
  { q: "How much is StorePulse Pro?", category: "conflict", expectBoth: ["03-storepulse-pricing-plans.docx", "08-storepulse-price-list-conflict.txt"] },
  { q: "what do you guys charge for the pro one", category: "conflict", expectBoth: ["03-storepulse-pricing-plans.docx", "08-storepulse-price-list-conflict.txt"] },
  { q: "What's the price of the StorePulse Pro plan per month?", category: "conflict", expectBoth: ["03-storepulse-pricing-plans.docx", "08-storepulse-price-list-conflict.txt"] },

  // ── FOLLOW-UPS — only meaningful WITH the conversation before them (16) ─
  // Each carries the turns that give it meaning, shaped like a real exchange
  // (the assistant's answer included — some follow-ups point at something only
  // the ASSISTANT said). Searched via POST /api/knowledge/search, which calls
  // retrieveForTurn() — the function respond() calls (§6.19).
  {
    q: "And the Growth one?", category: "followup", expectAny: ["02-clinichms-pricing.pdf", "11-clinichms-faq-it.md"],
    history: [U("How much is the ClinicHMS Starter plan?"), A("The ClinicHMS Starter plan is 89 euros per month and supports up to 2 practitioners.")],
  },
  {
    q: "What about the Pro one?", category: "followup", expectAny: ["03-storepulse-pricing-plans.docx", "08-storepulse-price-list-conflict.txt", "12-storepulse-plans.csv"],
    history: [U("What does StorePulse Lite cost?"), A("StorePulse Lite is 59 euros per month for one store.")],
  },
  {
    q: "What about weekends?", category: "followup", expect: "05-availability-and-support-hours.md",
    history: [U("What are your support hours for the Growth plan?"), A("Growth and Pro plan support runs Monday to Friday, 08:00 to 20:00 CET, by email and phone.")],
  },
  {
    q: "And monthly ones?", category: "followup", expect: "04-returns-and-refund-policy.txt",
    history: [U("Can I get a refund on an annual plan?"), A("Annual subscriptions have a 30 day money back guarantee from the purchase date.")],
  },
  {
    q: "Is there a free trial for that?", category: "followup", expectAny: ["02-clinichms-pricing.pdf", "04-returns-and-refund-policy.txt", "11-clinichms-faq-it.md"],
    history: [U("Tell me about the ClinicHMS Enterprise plan."), A("Enterprise has custom pricing, unlimited practitioners, multi-branch support, a dedicated account manager and 24/7 priority support.")],
  },
  {
    q: "What comes after that?", category: "followup", expect: "07-storepulse-user-guide.pdf",
    history: [U("How do I import my product catalog into StorePulse?"), A("You import a CSV export from your previous point of sale system and can correct the column mapping by hand before it runs.")],
  },
  {
    q: "Who pays for shipping?", category: "followup", expect: "04-returns-and-refund-policy.txt",
    history: [U("Can I return hardware I bought from you?"), A("Hardware add-ons can be returned within 30 days of delivery if they are unused and in their original packaging.")],
  },
  {
    q: "Is that required by law?", category: "followup", expect: "04-returns-and-refund-policy.txt",
    history: [U("How long is my data kept after I cancel?"), A("Exported data stays available for 90 days after cancellation, then it is permanently deleted.")],
  },
  {
    q: "Where is the main one?", category: "followup", expectAny: ["05-availability-and-support-hours.md", "11-clinichms-faq-it.md"],
    history: [U("Which regions do you serve?"), A("We serve Italy, the EU and the UK, with data centers in Frankfurt, Milan and London.")],
  },
  {
    q: "Can I change the wording?", category: "followup", expect: "06-clinichms-faq.md",
    history: [U("How are appointment reminders sent in ClinicHMS?"), A("Patients get SMS and email reminders 24 hours and again 2 hours before each appointment.")],
  },
  {
    q: "And on Starter?", category: "followup", expectAny: ["06-clinichms-faq.md", "02-clinichms-pricing.pdf"],
    history: [U("Do you have a pharmacy module?"), A("The ClinicHMS pharmacy module is included from the Growth plan upward.")],
  },
  {
    q: "How much is the second one?", category: "followup", expect: "03-storepulse-pricing-plans.docx",
    history: [U("What add-ons does StorePulse have?"), A("There is a barcode and label printing module, and a supplier portal.")],
  },
  {
    q: "E il Growth?", category: "followup", expectAny: ["02-clinichms-pricing.pdf", "11-clinichms-faq-it.md"],
    history: [U("Quanto costa il piano Starter di ClinicHMS?"), A("Il piano Starter costa 89 euro al mese per un massimo di 2 professionisti.")],
  },
  {
    q: "E per lo Starter?", category: "followup", expectAny: ["05-availability-and-support-hours.md", "11-clinichms-faq-it.md"],
    history: [U("Quali sono gli orari di assistenza per il piano Enterprise?"), A("Il piano Enterprise include assistenza 24 ore su 24, 7 giorni su 7.")],
  },
  {
    q: "What if there's a mismatch?", category: "followup", expect: "07-storepulse-user-guide.pdf",
    history: [U("How does StorePulse's end of day reconciliation work?"), A("Till staff run the end of day report, which compares recorded sales against the cash and card totals.")],
  },
  {
    q: "What about downgrading?", category: "followup", expect: "04-returns-and-refund-policy.txt",
    history: [U("Can I upgrade my plan partway through the month?"), A("Yes. An upgrade takes effect immediately and the difference is charged pro rata.")],
  },

  // ── OFF-TOPIC, ASKED MID-CONVERSATION — must STILL return nothing (4) ─
  // The failure a rewrite step can introduce: gluing an unrelated question
  // onto the previous topic until it retrieves that topic's price list.
  {
    q: "What's the weather like in Milan today?", category: "followup_offtopic",
    history: [U("How much is the Growth plan?"), A("The ClinicHMS Growth plan is 219 euros per month.")],
  },
  {
    q: "Can you help me renew my car insurance?", category: "followup_offtopic",
    history: [U("What are your support hours for Enterprise?"), A("Enterprise support is available 24 hours a day, 7 days a week.")],
  },
  {
    q: "What is the capital of France?", category: "followup_offtopic",
    history: [U("Can I get a refund on an annual plan?"), A("Annual subscriptions have a 30 day money back guarantee.")],
  },
  {
    q: "Do you sell mobile phone contracts?", category: "followup_offtopic",
    history: [U("Does StorePulse support more than one store?"), A("Yes, the Pro plan supports up to 5 stores with multi-branch sync.")],
  },
  // SHORT off-topic turns. The four above are all full sentences, which never
  // trip the cheap "needs context" check — so they only exercise the
  // empty-first-pass path. Callers also say short, off-topic things, and a
  // short message IS what the cheap check fires on: these are the cases where a
  // naive "glue the last question on" strategy is most dangerous.
  {
    q: "What about the weather?", category: "followup_offtopic",
    history: [U("How much is the Growth plan?"), A("The ClinicHMS Growth plan is 219 euros per month.")],
  },
  {
    q: "And the football score?", category: "followup_offtopic",
    history: [U("What are your support hours for Enterprise?"), A("Enterprise support is available 24 hours a day, 7 days a week.")],
  },
  {
    q: "Who won yesterday?", category: "followup_offtopic",
    history: [U("Can I get a refund on an annual plan?"), A("Annual subscriptions have a 30 day money back guarantee.")],
  },
];
