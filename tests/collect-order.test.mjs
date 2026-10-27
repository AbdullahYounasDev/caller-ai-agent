import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { parseOrderText, readOrder, mergeOrder, orderDisplay, mentionsOrderChange } from "@/lib/collect/order";
import { advanceCollection, readsAsAnswer, summarise } from "@/lib/collect/engine";
import { normalizeCollectConfig, presetConfig, validateCollectConfig, enabledRecordTypes, missingLists, typeFields, fieldApplies } from "@/lib/collect/config";
import { detectStartType } from "@/lib/collect/phrases";
import { validateValue, matchOption } from "@/lib/collect/validate";
import { buildCollectionInstruction, buildExtractionInstruction } from "@/lib/agent/prompt";
import { getField } from "@/lib/collect/catalog";

// Restaurant orders (CLAUDE.md §6.25): only dishes on the business's menu, pickup or delivery,
// the address only for delivery, saved as a request the team confirms — never "order placed".

const MENU = [
  { id: "chicken_biryani", label: { en: "Chicken Biryani", ur: "چکن بریانی" } },
  { id: "beef_biryani", label: { en: "Beef Biryani", ur: "بیف بریانی" } },
  { id: "raita", label: { en: "Raita", ur: "رائتہ" } },
  { id: "zinger_burger", label: { en: "Zinger Burger", ur: "زنگر برگر" } },
  { id: "coke", label: { en: "Coke", ur: "کوک" } },
];
const NOW = Date.UTC(2026, 9, 21, 7, 0);
const HOURS = { mon: [["11:00", "23:00"]], tue: [["11:00", "23:00"]], wed: [["11:00", "23:00"]], thu: [["11:00", "23:00"]], fri: [["11:00", "23:00"]], sat: [["11:00", "23:00"]], sun: [["11:00", "23:00"]] };
const restaurant = (over = {}) => normalizeCollectConfig({ ...presetConfig("restaurant"), enabled: true, menu: MENU, ...over });
const agent = { replyLanguage: "en", timezone: "Asia/Karachi", hours: HOURS };
const lines = (order) => order.map((l) => `${l.qty} ${l.id}`).join(", ");

describe("reading an order against the menu (rules)", () => {
  test("dishes and quantities in English, Urdu script and Roman Urdu", () => {
    assert.equal(lines(mergeOrder([], parseOrderText("I'd like two chicken biryani and a raita please", MENU))), "2 chicken_biryani, 1 raita");
    assert.equal(lines(mergeOrder([], parseOrderText("do chicken biryani aur ek raita", MENU))), "2 chicken_biryani, 1 raita");
    assert.equal(lines(mergeOrder([], parseOrderText("دو چکن بریانی اور ایک رائتہ", MENU))), "2 chicken_biryani, 1 raita");
    assert.equal(lines(mergeOrder([], parseOrderText("2 plates of chicken biryanis", MENU))), "2 chicken_biryani");
    assert.equal(lines(mergeOrder([], parseOrderText("zinger x 3", MENU))), "3 zinger_burger");
    assert.equal(lines(mergeOrder([], parseOrderText("one chicken biriyani", MENU))), "1 chicken_biryani", "a one-letter slip in a long word");
  });

  test("a word that could be several dishes is asked about, never guessed", () => {
    const read = parseOrderText("one biryani please", MENU);
    assert.deepEqual(read.lines, []);
    assert.deepEqual(read.ambiguous, [{ said: "biryani", options: ["Chicken Biryani", "Beef Biryani"] }]);
  });

  test("a dish that is not on the menu is never found by the rules", () => {
    const pizza = parseOrderText("I want a pizza", MENU);
    assert.deepEqual(pizza.lines, []);
    assert.deepEqual(pizza.unmatched, ["pizza"], "…but the word is left over, so the extractor is asked too");
    // …and a lone generic word is not a dish
    const chicken = parseOrderText("I like chicken", MENU);
    assert.deepEqual([chicken.lines, chicken.removed, chicken.ambiguous], [[], [], []]);
    assert.deepEqual(parseOrderText("two chicken biryanis and a raita please", MENU).unmatched, [], "nothing left over: no model call needed");
  });

  test("the extractor's list: dishes matched by name, not-on-the-menu and ambiguous ones reported", () => {
    const read = readOrder("2 x Chicken Biryani; 1 x Pizza; 1 x biryani; 0 x Raita", MENU);
    assert.deepEqual(read.lines, [{ id: "chicken_biryani", name: "Chicken Biryani", qty: 2 }]);
    assert.deepEqual(read.removed, ["raita"]);
    assert.deepEqual(read.unknown, ["Pizza"]);
    assert.equal(read.ambiguous[0].said, "biryani");
  });

  test("a later message changes the order: a new number, 'another', 'no raita', 'hata dein'", () => {
    let order = mergeOrder([], parseOrderText("two chicken biryani and a raita", MENU));
    order = mergeOrder(order, parseOrderText("make it three chicken biryani, and add a coke", MENU));
    assert.equal(lines(order), "3 chicken_biryani, 1 raita, 1 coke");
    order = mergeOrder(order, parseOrderText("add another coke", MENU));
    assert.equal(lines(order), "3 chicken_biryani, 1 raita, 2 coke");
    order = mergeOrder(order, parseOrderText("no raita", MENU));
    assert.equal(lines(order), "3 chicken_biryani, 2 coke");
    order = mergeOrder(order, parseOrderText("coke hata dein", MENU));
    assert.equal(lines(order), "3 chicken_biryani");
    // Talking about a dish already ordered, with no number, changes nothing.
    assert.equal(lines(mergeOrder(order, parseOrderText("the chicken biryani is for my son", MENU))), "3 chicken_biryani");
  });

  test("only a message that SAYS it changes the order may change it", () => {
    for (const text of ["add a coke", "also one raita", "remove the raita", "make it three", "aur bhi ek coke", "رائتہ ہٹا دیں"]) assert.ok(mentionsOrderChange(text), text);
    for (const text of ["House 5, Biryani Street", "my name is Ahmed", "as soon as possible"]) assert.ok(!mentionsOrderChange(text), text);
  });

  test("shown with the menu's own names, in the language asked for; a dish since removed keeps its stored name", () => {
    const order = [{ id: "chicken_biryani", name: "Chicken Biryani", qty: 2 }, { id: "gone", name: "Old Special", qty: 1 }];
    assert.equal(orderDisplay(order, MENU, "en"), "2 × Chicken Biryani, 1 × Old Special");
    assert.equal(orderDisplay(order, MENU, "ur"), "2 × چکن بریانی, 1 × Old Special");
  });

  test("validation: something must be ordered, quantities 1–50, at most 20 dishes", () => {
    const def = getField("order_items");
    const ctx = { config: { menu: MENU }, language: "en" };
    assert.equal(validateValue(def, [], ctx).reason, "empty_order");
    assert.equal(validateValue(def, [{ id: "raita", name: "Raita", qty: 0 }], ctx).reason, "out_of_range");
    assert.equal(validateValue(def, [{ id: "raita", name: "Raita", qty: 51 }], ctx).reason, "out_of_range");
    const ok = validateValue(def, [{ id: "raita", name: "Raita", qty: 2 }], ctx);
    assert.deepEqual(ok, { ok: true, value: [{ id: "raita", name: "Raita", qty: 2 }], display: "2 × Raita" });
  });

  test("pickup or delivery, the way callers say it", () => {
    const options = getField("order_type").options;
    for (const [said, id] of [["pickup", "pickup"], ["I'll pick it up", "pickup"], ["takeaway please", "pickup"], ["khud le jayenge", "pickup"], ["خود لے جائیں گے", "pickup"],
      ["delivery", "delivery"], ["please deliver it", "delivery"], ["ghar pe bhej dein", "delivery"], ["ڈیلیوری چاہیے", "delivery"]]) {
      assert.equal(matchOption(said, options)?.id, id, said);
    }
  });
});

describe("settings", () => {
  test("the restaurant preset takes orders: name, phone, the order, pickup or delivery, the address only for delivery, then notes", () => {
    const c = restaurant();
    assert.deepEqual(enabledRecordTypes(c), ["appointment", "callback", "order"]);
    const fields = typeFields(c, "order");
    assert.deepEqual(fields.map((f) => f.id), ["name", "phone", "order_items", "order_type", "address", "notes"]);
    const address = fields.find((f) => f.id === "address");
    assert.deepEqual(address.when, { field: "order_type", equals: "delivery" });
    assert.equal(address.question.en, "What is the delivery address?");
    assert.ok(fieldApplies(address, { order_type: "delivery" }) && !fieldApplies(address, { order_type: "pickup" }) && !fieldApplies(address, {}));
  });

  test("no menu: orders are not offered, and the console is told why — the rest of the settings still save", () => {
    const c = normalizeCollectConfig({ ...presetConfig("restaurant"), enabled: true });
    assert.deepEqual(enabledRecordTypes(c), ["appointment", "callback"]);
    assert.deepEqual(missingLists(c), [{ type: "order", list: "menu" }]);
    assert.deepEqual(missingLists(restaurant()), []);
    assert.deepEqual(validateCollectConfig({ ...presetConfig("restaurant"), enabled: true }).problems, []);
  });

  test("the menu is the owner's own list; a broken condition is refused on save and dropped on read", () => {
    const c = restaurant();
    assert.deepEqual(c.menu.map((m) => m.id), MENU.map((m) => m.id));
    const broken = presetConfig("restaurant");
    broken.menu = MENU;
    broken.recordTypes.order.fields.find((f) => f.id === "address").when = { field: "order_type", equals: "by_drone" };
    assert.ok(validateCollectConfig(broken).problems.some((p) => p.code === "conditionInvalid"));
    assert.equal(typeFields(normalizeCollectConfig(broken), "order").find((f) => f.id === "address").when, undefined, "read: always asked rather than never");
  });

  test("other presets keep orders off", () => {
    assert.ok(!enabledRecordTypes(normalizeCollectConfig({ ...presetConfig("dental"), enabled: true, menu: MENU })).includes("order"));
  });
});

describe("starting an order", () => {
  test("in English, Urdu and Roman Urdu; a table booking stays a booking; asking about an existing order starts nothing", () => {
    const types = ["appointment", "callback", "order"];
    for (const text of ["I'd like to order some food", "Can I place an order for delivery?", "I want to order two chicken biryanis", "order karna hai", "khana mangwana hai", "مجھے کھانا منگوانا ہے", "آرڈر دینا ہے"]) {
      assert.equal(detectStartType(text, types), "order", text);
    }
    assert.equal(detectStartType("I want to book a table for four", types), "appointment");
    for (const text of ["Where is my order?", "I want to cancel my order", "mera order kahan hai", "میرا آرڈر کہاں ہے"]) assert.equal(detectStartType(text, types), null, text);
    assert.equal(detectStartType("I'd like to order", ["appointment", "callback"]), null, "not offered when orders are off");
  });
});

/** A conversation against the engine with the model and the database faked. */
function conversation({ collect = restaurant(), extract = null } = {}) {
  const saved = [];
  const updates = [];
  let draft = null;
  let ids = 0;
  const deps = {
    newId: () => `draft-${++ids}`,
    extract,
    submit: async (record) => {
      const row = { ...record, id: `rec-${saved.length + 1}`, reference: `OR-${saved.length + 1}ABCD` };
      saved.push(row);
      return row;
    },
    update: async (id, record) => {
      updates.push({ id, ...record });
      Object.assign(saved.find((s) => s.id === id), record);
      return { ok: true };
    },
    withdraw: async () => ({ ok: true }),
  };
  return {
    saved,
    updates,
    get draft() {
      return draft;
    },
    async say(message) {
      const r = await advanceCollection({ collect, agent, draft, message, nowMs: NOW, deps });
      draft = r.draft;
      return r;
    },
  };
}

describe("taking an order, end to end (rules only)", () => {
  test("pickup: the address is never asked, the order is saved at the last required detail, and it reads well", async () => {
    const c = conversation();
    let r = await c.say("Hi, I'd like to order two chicken biryanis and a raita");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.type, "order");
    assert.equal(r.plan.ask.id, "name", "the dishes said with the start are already taken");
    assert.equal(r.plan.collected.find((l) => l.id === "order_items").display, "2 × Chicken Biryani, 1 × Raita");
    r = await c.say("Ahmed Khan");
    r = await c.say("0300 1234567");
    assert.equal(r.plan.ask.id, "order_type");
    r = await c.say("I'll pick it up");
    assert.equal(c.saved.length, 1, "saved: every required detail is in (no address for a pickup)");
    assert.equal(r.plan.ask.id, "notes", "then the optional question");
    assert.deepEqual(c.saved[0].values.order_items, [
      { id: "chicken_biryani", name: "Chicken Biryani", qty: 2 },
      { id: "raita", name: "Raita", qty: 1 },
    ]);
    assert.equal(c.saved[0].values.order_type, "pickup");
    assert.equal(c.saved[0].summary, "Ahmed Khan · 2 × Chicken Biryani, 1 × Raita · Pickup");
    r = await c.say("no");
    assert.equal(r.plan.state, "saved");
    assert.ok(!r.plan.lines.some((l) => l.id === "address"));
  });

  test("delivery: the address is asked, and is required", async () => {
    const c = conversation();
    await c.say("order karna hai");
    await c.say("Sara");
    await c.say("03211234567");
    let r = await c.say("one zinger burger and a coke");
    assert.equal(r.plan.ask.id, "order_type");
    r = await c.say("home delivery please");
    assert.equal(r.plan.ask.id, "address");
    assert.equal(r.plan.ask.question, "What is the delivery address?");
    assert.equal(c.saved.length, 0, "not saved yet: a delivery needs its address");
    r = await c.say("House 5, Street 3, F-7, Islamabad");
    assert.equal(c.saved.length, 1);
    assert.equal(c.saved[0].values.address, "House 5, Street 3, F-7, Islamabad");
    assert.equal(lines(c.saved[0].values.order_items), "1 zinger_burger, 1 coke", "the address never adds a dish");
  });

  test("a dish that is not on the menu is told about; the rest of the order is kept", async () => {
    // A model that hears the dishes the latest message names, as the prompt asks.
    const extract = async ({ message }) => ({ values: /pizza/i.test(message) ? { order_items: "2 x Chicken Biryani; 1 x Pizza" } : {}, date: null, time: null });
    const c = conversation({ extract });
    await c.say("I want to place an order");
    await c.say("Ali");
    await c.say("0300 7654321");
    const r = await c.say("Two chicken biryanis and also a pizza for the kids, please");
    assert.equal(r.plan.problem.reason, "not_on_menu");
    assert.equal(r.plan.problem.vars.items, "Pizza");
    assert.equal(r.plan.problem.partial, true);
    assert.equal(r.plan.ask.id, "order_type", "the rest of the order is noted and the call moves on");
    assert.equal(r.plan.collected.find((l) => l.id === "order_items").display, "2 × Chicken Biryani");
  });

  test("only a dish that is not on the menu: asked again, nothing written", async () => {
    const extract = async ({ message }) => ({ values: /pizza/i.test(message) ? { order_items: "1 x Pizza" } : {}, date: null, time: null });
    const c = conversation({ extract });
    await c.say("I want to place an order");
    await c.say("Ali");
    await c.say("0300 7654321");
    const r = await c.say("Can I get a large pepperoni pizza");
    assert.equal(r.plan.ask.id, "order_items");
    assert.equal(r.plan.problem.reason, "not_on_menu");
    assert.equal(c.draft.values.order_items, undefined);
  });

  test("'biryani' with two biryanis on the menu: the agent asks which one", async () => {
    const c = conversation();
    await c.say("I want to place an order");
    await c.say("Ali");
    await c.say("0300 7654321");
    let r = await c.say("one biryani");
    assert.equal(r.plan.problem.reason, "ambiguous_item");
    assert.equal(r.plan.problem.vars.options, "Chicken Biryani, Beef Biryani");
    r = await c.say("beef biryani");
    assert.equal(lines(c.draft.values.order_items), "1 beef_biryani");
    assert.equal(r.plan.ask.id, "order_type");
  });

  test("a change after the order is saved updates the same request", async () => {
    const c = conversation();
    await c.say("I'd like to order two chicken biryanis");
    await c.say("Ahmed");
    await c.say("0300 1234567");
    await c.say("pickup");
    let r = await c.say("no thanks");
    assert.equal(r.plan.state, "saved");
    r = await c.say("Sorry, add a coke as well");
    assert.equal(c.saved.length, 1);
    assert.equal(lines(c.saved[0].values.order_items), "2 chicken_biryani, 1 coke");
    assert.deepEqual(r.plan.corrected.map((l) => l.id), ["order_items"]);
  });

  test("switching from delivery to pickup drops the address from what the team gets", async () => {
    const c = conversation();
    await c.say("I'd like to order a zinger burger");
    await c.say("Ahmed");
    await c.say("0300 1234567");
    await c.say("delivery");
    await c.say("House 5, Street 3");
    assert.equal(c.saved[0].values.address, "House 5, Street 3");
    await c.say("no");
    await c.say("actually I'll pick it up instead");
    assert.equal(c.saved[0].values.order_type, "pickup");
    assert.equal(c.saved[0].values.address, undefined);
  });

  test("an answer to the order question needs no document search", () => {
    const collect = restaurant();
    const draft = { v: 1, id: "d", type: "order", stage: "collecting", values: { name: "A", phone: "+923001234567" }, partial: {}, skipped: [], asked: [], asking: "order_items", retries: {}, startedAt: NOW, updatedAt: NOW };
    assert.ok(readsAsAnswer({ collect, agent, draft, message: "two chicken biryanis and a raita", nowMs: NOW }));
    assert.ok(!readsAsAnswer({ collect, agent, draft, message: "is the biryani spicy?", nowMs: NOW }));
  });

  test("summary for the records list", () => {
    const collect = restaurant();
    const fields = typeFields(collect, "order");
    const draft = { values: { name: "Sara", order_items: [{ id: "coke", name: "Coke", qty: 2 }], order_type: "delivery", address: "House 5" } };
    assert.equal(summarise(draft, fields, { config: collect, language: "en" }), "Sara · 2 × Coke · Delivery");
  });
});

describe("what the model is told", () => {
  test("an order plan forbids 'placed', invented prices and totals, and offers the menu", async () => {
    const c = conversation();
    await c.say("I want to place an order");
    await c.say("Ali");
    const r = await c.say("0300 7654321");
    const text = buildCollectionInstruction(r.plan, { channel: "voice" });
    assert.match(text, /Never say the order is placed, confirmed, being prepared or on its way/);
    assert.match(text, /Never state a price or a total unless it is in the reference material/);
    assert.match(text, /Only dishes on the menu can be ordered;.*Chicken Biryani/);
  });

  test("the extractor writes the order as '2 x dish' with the menu's names, and reports dishes not on it", () => {
    const collect = restaurant();
    const text = buildExtractionInstruction({ fields: typeFields(collect, "order"), config: collect, nowMs: NOW, timezone: "Asia/Karachi", hours: HOURS, language: "en" });
    assert.match(text, /order_items — Order — .*"2 x <dish>; 1 x <dish>".*Chicken Biryani \/ چکن بریانی/);
    assert.match(text, /NOT on the menu exactly as they said it/);
    assert.match(text, /order_type — Pickup or delivery — answer with ONE of these ids: pickup \(Pickup \/ پک اپ\); delivery/);
  });

  test("a partial problem keeps the rest of the order", () => {
    const plan = { state: "ask", type: "order", typeLabel: "Order request", language: "en", collected: [], ask: { id: "order_type", label: "Pickup or delivery", question: "Pickup or delivery?", required: true }, problem: { field: { id: "order_items", label: "Order" }, reason: "not_on_menu", vars: { items: "Pizza" }, partial: true } };
    assert.match(buildCollectionInstruction(plan, { channel: "chat" }), /Part of the customer's last answer for "Order" could not be taken: Pizza is not on the menu.*the rest of it IS noted/);
  });
});
