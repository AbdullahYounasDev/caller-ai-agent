/**
 * A FOOD ORDER, UNDERSTOOD AND CHECKED AGAINST THE MENU — pure, no I/O (CLAUDE.md §6.25).
 *
 * The `order_items` field (catalog.js) holds what a caller orders: lines of a dish from the
 * business's MENU (its own list, like its services) and how many. The agent may only take
 * dishes the business sells: a dish that is not on the menu is never written into an order,
 * and the caller is told so. Prices are not here at all — the team confirms the order and its
 * total (prompt.js tells the model never to quote a price the documents do not give).
 *
 *   readOrder(raw, menu)        what one message said: dishes + quantities, removals, and the
 *                               dishes that are NOT on the menu or could mean several
 *   mergeOrder(existing, read)  a later message changes the order ("add a coke", "make it three
 *                               biryanis", "no raita") instead of replacing it
 *   orderDisplay(lines, menu)   "2 × Chicken Biryani, 1 × Raita"
 *
 * Two readers feed readOrder. The RULES (parseOrderText) scan free speech for the menu's own
 * dish names — "two chicken biryani and a raita", "do biryani aur ek raita", "دو چکن بریانی" —
 * with the quantity said in front ("2", "two", "do", "دو", "2 plates of"). They never guess a
 * dish that is not on the menu. The EXTRACTOR (extract.js) writes what it heard as
 * "2 x Chicken Biryani; 1 x Pizza"; its names are matched here too, and "Pizza" comes back as
 * not on the menu. A model never decides what is on the menu.
 *
 * Stored value: [{ id, name, qty }] — `name` is the dish's name when it was ordered, so an old
 * order still reads correctly after the owner renames or removes a dish.
 *
 * Tests: tests/collect-order.test.mjs.
 */

export const ORDER_LIMITS = { linesMax: 20, qtyMin: 1, qtyMax: 50 };

const ARABIC_INDIC = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

/** Lower case, digits in ASCII, Urdu diacritics gone, "2x"/"x2" split, punctuation to spaces. */
function fold(text) {
  return String(text ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/(\d)\s*[x×*]/g, "$1 x ")
    .replace(/[x×*]\s*(\d)/g, " x $1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const tokensOf = (text) => fold(text).split(" ").filter(Boolean);

const NUMBER_WORDS = new Map(
  Object.entries({
    1: "a an one single ek aik ایک",
    2: "two do دو",
    3: "three teen تین",
    4: "four char chaar چار",
    5: "five panch paanch پانچ",
    6: "six che chay chhe چھ",
    7: "seven saat سات",
    8: "eight aath آٹھ",
    9: "nine nau نو",
    10: "ten das دس",
    11: "eleven gyarah گیارہ",
    12: "twelve dozen barah بارہ",
  }).flatMap(([n, words]) => words.split(" ").map((w) => [w, Number(n)]))
);

/** Words that sit between a quantity and the dish: "2 PLATES OF biryani", "دو پلیٹ بریانی". */
const UNIT_WORDS = new Set(
  (
    "x of plate plates piece pieces pcs portion portions serving servings glass glasses bottle bottles cup cups can cans box boxes order orders pack packs " +
    "پلیٹ پلیٹیں پیس گلاس بوتل بوتلیں کپ ڈبہ ڈبے آرڈر " +
    "plate plaate pees peace dabba dabbe"
  ).split(/\s+/)
);
/** "ANOTHER biryani", "two MORE", "ek AUR": add to what is already ordered. */
const MORE_WORDS = new Set("more another extra additional aur mazeed bhi مزید اور بھی".split(" "));
/** In front of a dish: take it out ("NO raita", "WITHOUT raita", "بغیر رائتہ"). */
const REMOVE_BEFORE = new Set("no without remove minus cancel drop skip بغیر baghair bagair".split(" "));
/** After a dish: take it out ("raita HATA dein", "raita NAHI chahiye", "رائتہ ہٹا دیں"). */
const REMOVE_AFTER = new Set("hata hatado hatao nikal nikaal nikalo cancel remove nahi nahin ہٹا ہٹائیں نکال نکالیں نہیں کینسل".split(" "));
/** Words that never name a dish by themselves: a lone "chicken" in a sentence is not an order. */
const GENERIC_WORDS = new Set(
  ("chicken beef mutton fish lamb veg vegetable special large small medium regular full half extra spicy mild fried grilled " +
    "cold hot drink drinks meal deal combo family single double plain with and the our your house " +
    "چکن بیف مٹن مچھلی سپیشل بڑا بڑی چھوٹا چھوٹی فل ہاف").split(" ")
);
const SKIPPABLE_BEFORE = new Set("the a an any some my".split(" "));
/**
 * Words around an order that are not dishes. What is left after these, the dishes, the numbers
 * and the units is `unmatched` — "and a PIZZA for the KIDS" — and that is when the extractor is
 * asked too, because the rules cannot tell a dish that is not on the menu from any other word.
 */
const ORDER_FILLER = new Set(
  ("i id im would like want wanna need please pls can could get have give me us and also plus with for to order place an the some " +
    "of just thanks thank you hi hello yes ok okay that it all be will is my our please one two that's thats this those these " +
    "mujhe mujhay chahiye chahye chaiye de dein den dena dijiye aur bhi ek aik kar karna karni hai hain ji jee order bhej plz " +
    "مجھے چاہیے چاہئے اور بھی دیں دے دیجیے کریں کرنا ہے ہیں جی براہ کرم آرڈر ایک بھیج").split(" ")
);

/** Optimal-string-alignment distance, stopping early above `limit`. */
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > limit) return limit + 1;
  }
  return d[a.length][b.length];
}

/** Same word, allowing a plural ("biryanis") and, for long words, one slip ("biriyani"). */
function sameWord(said, menuWord) {
  if (said === menuWord) return true;
  if (said === `${menuWord}s` || said === `${menuWord}es` || menuWord === `${said}s`) return true;
  return menuWord.length >= 6 && said.length >= 5 && distance(said, menuWord, 1) <= 1;
}

/**
 * The menu as something to match against: each dish with its names (English and Urdu) as token
 * lists, and the words in them.
 * @param {Array<{id: string, label: {en?: string, ur?: string}}>} menu
 */
function indexMenu(menu) {
  return (menu ?? []).map((item) => {
    const names = [item.label?.en, item.label?.ur].filter(Boolean).map(tokensOf).filter((t) => t.length);
    return { id: item.id, name: item.label?.en || item.label?.ur || item.id, names, words: [...new Set(names.flat())] };
  });
}

/** The longest full dish name starting at tokens[at]: { item, length } or null. */
function fullMatchAt(tokens, at, index) {
  let best = null;
  for (const item of index) {
    for (const name of item.names) {
      if (at + name.length > tokens.length || (best && name.length <= best.length)) continue;
      if (name.every((w, k) => sameWord(tokens[at + k], w))) best = { item, length: name.length };
    }
  }
  return best;
}

/** Dishes one word could mean ("biryani" → every biryani on the menu). */
function itemsWithWord(word, index) {
  return index.filter((item) => item.words.some((w) => w.length >= 3 && sameWord(word, w)));
}

const numberAt = (token) => (/^\d+$/.test(token ?? "") ? Number(token) : NUMBER_WORDS.get(token ?? "") ?? null);

/** The quantity said in front of tokens[at] (skipping "plates of"), and whether it adds ("two more"). */
function quantityBefore(tokens, at) {
  let i = at - 1;
  let skipped = 0;
  let add = false;
  while (i >= 0 && skipped < 3 && (UNIT_WORDS.has(tokens[i]) || MORE_WORDS.has(tokens[i]))) {
    if (MORE_WORDS.has(tokens[i])) add = true;
    i--;
    skipped++;
  }
  const qty = i >= 0 ? numberAt(tokens[i]) : null;
  // "another biryani": one more, with no number said.
  if (qty == null && add) return { qty: 1, add: true };
  // "a" / "an" only count as one right in front of the dish ("a raita"), never across "plates of".
  if (qty === 1 && /^(a|an)$/.test(tokens[i]) && skipped > 0) return { qty: null, add };
  return { qty, add };
}

/** "biryani x 2", "biryani 2 plates". */
function quantityAfter(tokens, end) {
  if (tokens[end] === "x" && numberAt(tokens[end + 1]) != null && /^\d+$/.test(tokens[end + 1])) return numberAt(tokens[end + 1]);
  if (/^\d+$/.test(tokens[end] ?? "") && UNIT_WORDS.has(tokens[end + 1] ?? "")) return Number(tokens[end]);
  return null;
}

function removalAround(tokens, start, end) {
  for (let i = start - 1, n = 0; i >= 0 && n < 2; i--, n++) {
    if (REMOVE_BEFORE.has(tokens[i])) return true;
    if (!SKIPPABLE_BEFORE.has(tokens[i])) break;
  }
  return REMOVE_AFTER.has(tokens[end]);
}

/**
 * The RULES' reading of free speech: every dish on the menu the message names, with what was
 * said about it. Never guesses a dish that is not on the menu; a word that could mean several
 * dishes ("biryani" with chicken and beef biryani on the menu) comes back as ambiguous.
 *
 * @param {string} text
 * @param {Array} menu
 * @returns {{lines: Array<{id: string, name: string, qty: number|null, add?: boolean}>, removed: string[], unknown: string[], ambiguous: Array<{said: string, options: string[]}>}}
 */
export function parseOrderText(text, menu) {
  const index = indexMenu(menu);
  const out = { lines: [], removed: [], unknown: [], ambiguous: [], unmatched: [] };
  if (!index.length) return out;
  const tokens = tokensOf(text);
  const used = new Set();
  for (let i = 0; i < tokens.length; ) {
    let item = null;
    let length = 0;
    const full = fullMatchAt(tokens, i, index);
    if (full) ({ item, length } = full);
    else if (tokens[i].length >= 4 && !GENERIC_WORDS.has(tokens[i]) && !UNIT_WORDS.has(tokens[i])) {
      const candidates = itemsWithWord(tokens[i], index);
      if (candidates.length === 1) [item, length] = [candidates[0], 1];
      else if (candidates.length > 1) {
        out.ambiguous.push({ said: tokens[i], options: candidates.map((c) => c.name) });
        used.add(i);
        i++;
        continue;
      }
    }
    if (!item) {
      i++;
      continue;
    }
    const end = i + length;
    for (let k = i; k < end; k++) used.add(k);
    if (removalAround(tokens, i, end)) out.removed.push(item.id);
    else {
      const before = quantityBefore(tokens, i);
      const qty = before.qty ?? quantityAfter(tokens, end);
      out.lines.push({ id: item.id, name: item.name, qty, ...(before.add ? { add: true } : {}) });
    }
    i = end;
  }
  out.unmatched = tokens.filter(
    (w, k) =>
      !used.has(k) &&
      w.length > 2 &&
      numberAt(w) == null &&
      !ORDER_FILLER.has(w) &&
      !UNIT_WORDS.has(w) &&
      !MORE_WORDS.has(w) &&
      !REMOVE_BEFORE.has(w) &&
      !REMOVE_AFTER.has(w) &&
      !SKIPPABLE_BEFORE.has(w)
  );
  return out;
}

/**
 * Two readings of one message, combined: the RULES' dishes (they are exact about the menu) and
 * what only the EXTRACTOR could see — a dish that is not on the menu, or one the rules missed.
 */
export function combineOrderReads(rules, model, menu) {
  const fromModel = readOrder(model, menu);
  const known = new Set([...(rules.lines ?? []).map((l) => l.id), ...(rules.removed ?? [])]);
  return {
    lines: [...(rules.lines ?? []), ...fromModel.lines.filter((l) => !known.has(l.id))],
    removed: [...new Set([...(rules.removed ?? []), ...fromModel.removed])],
    unknown: fromModel.unknown,
    ambiguous: rules.ambiguous?.length ? rules.ambiguous : fromModel.ambiguous,
  };
}

/**
 * A dish NAME on its own (from the extractor: "Chicken Biryani", "biryani", "pizza"): the one
 * menu dish it names, several it could mean, or none.
 */
function matchName(name, index) {
  const said = tokensOf(name).filter((w) => !UNIT_WORDS.has(w) && !SKIPPABLE_BEFORE.has(w));
  if (!said.length) return { item: null, options: [] };
  const exact = index.filter((item) => item.names.some((n) => n.length === said.length && n.every((w, k) => sameWord(said[k], w))));
  if (exact.length === 1) return { item: exact[0], options: [] };
  const containing = index.filter((item) => said.every((w) => item.words.some((m) => sameWord(w, m))));
  if (containing.length === 1) return { item: containing[0], options: [] };
  return { item: null, options: containing.map((c) => c.name) };
}

/** "2 x Chicken Biryani; 1 x Raita; 0 x Coke" — the extractor's form — or a plain list. */
function parseOrderList(text, index) {
  const out = { lines: [], removed: [], unknown: [], ambiguous: [] };
  const parts = String(text)
    .split(/[;\n,،]+|\s+(?:and|aur|اور|plus|&)\s+/iu)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    let tokens = tokensOf(part);
    let qty = null;
    let add = false;
    if (MORE_WORDS.has(tokens[0])) [add, tokens] = [true, tokens.slice(1)];
    if (numberAt(tokens[0]) != null && tokens.length > 1) {
      qty = numberAt(tokens[0]);
      tokens = tokens.slice(1);
    }
    if (MORE_WORDS.has(tokens[0])) [add, tokens] = [true, tokens.slice(1)];
    if (tokens[0] === "x") tokens = tokens.slice(1);
    const trailing = tokens.length > 2 && tokens.at(-2) === "x" && /^\d+$/.test(tokens.at(-1)) ? Number(tokens.at(-1)) : null;
    if (trailing != null) [qty, tokens] = [trailing, tokens.slice(0, -2)];
    if (!tokens.length) continue;
    const { item, options } = matchName(tokens.join(" "), index);
    if (item) {
      if (qty === 0) out.removed.push(item.id);
      else out.lines.push({ id: item.id, name: item.name, qty, ...(add ? { add: true } : {}) });
    } else if (options.length > 1) out.ambiguous.push({ said: tokens.join(" "), options });
    else if (qty !== 0) out.unknown.push(part.replace(/^\s*\d+\s*[x×]?\s*/i, "").trim() || part);
  }
  return out;
}

/**
 * What a message said about the order, from whichever reader produced it: the rules' object
 * (parseOrderText), the extractor's text ("2 x Chicken Biryani; 1 x Pizza"), or a list of
 * { id | name | item, qty }.
 *
 * @param {unknown} raw
 * @param {Array} menu
 */
export function readOrder(raw, menu) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.lines)) {
    return { lines: raw.lines, removed: raw.removed ?? [], unknown: raw.unknown ?? [], ambiguous: raw.ambiguous ?? [] };
  }
  const index = indexMenu(menu);
  if (Array.isArray(raw)) {
    const text = raw
      .map((entry) => {
        const id = entry?.id && index.find((i) => i.id === entry.id);
        const name = id ? id.name : entry?.name ?? entry?.item ?? "";
        const qty = Number.isFinite(Number(entry?.qty)) ? Number(entry.qty) : null;
        return qty == null ? String(name) : `${qty} x ${name}`;
      })
      .join("; ");
    return parseOrderList(text, index);
  }
  if (typeof raw === "string" && raw.trim()) return parseOrderList(raw, index);
  return { lines: [], removed: [], unknown: [], ambiguous: [] };
}

/**
 * Fold what one message said into the order so far. A dish said again with a number takes that
 * number ("make it three biryanis"); with "more"/"another" the number is added; said again with
 * no number it is left as it is (the caller is talking about it, not ordering it twice). A new
 * dish with no number is one.
 *
 * @param {Array<{id: string, name: string, qty: number}>} existing
 * @param {{lines: Array, removed: string[]}} read
 * @returns {Array<{id: string, name: string, qty: number}>}
 */
export function mergeOrder(existing, read) {
  const out = (Array.isArray(existing) ? existing : []).map((l) => ({ ...l }));
  for (const id of read.removed ?? []) {
    const at = out.findIndex((l) => l.id === id);
    if (at >= 0) out.splice(at, 1);
  }
  for (const line of read.lines ?? []) {
    const at = out.findIndex((l) => l.id === line.id);
    if (line.qty === 0) {
      if (at >= 0) out.splice(at, 1);
      continue;
    }
    if (at >= 0) {
      if (line.add) out[at].qty += line.qty ?? 1;
      else if (line.qty != null) out[at].qty = line.qty;
    } else out.push({ id: line.id, name: line.name, qty: line.qty ?? 1 });
  }
  return out;
}

/** Did a message mention changing an order that is already taken ("add", "also", "remove", "make it")? */
const CHANGE = /(?<![\p{L}\p{M}])(?:add|also|plus|more|another|extra|remove|take off|without|instead|make it|change|cancel the|no more|aur bhi|bhi|mazeed|hata|nikal|ki jagah|ke bajaye|اور بھی|بھی|مزید|ہٹا|نکال|کی جگہ|کے بجائے)(?![\p{L}\p{M}])/iu;
export function mentionsOrderChange(message) {
  return CHANGE.test(String(message ?? ""));
}

/**
 * "2 × Chicken Biryani, 1 × Raita" — dish names from the menu as it is now, in the language
 * asked for, falling back to the name stored with the order.
 */
export function orderDisplay(lines, menu, language = "en") {
  if (!Array.isArray(lines)) return String(lines ?? "");
  return lines
    .map((line) => {
      const dish = (menu ?? []).find((m) => m.id === line.id);
      const name = (dish && (dish.label?.[language] || dish.label?.en || dish.label?.ur)) || line.name || line.id;
      return `${line.qty} × ${name}`;
    })
    .join(", ");
}
