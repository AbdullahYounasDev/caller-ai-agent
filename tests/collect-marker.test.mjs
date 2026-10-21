import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createMarkerFilter, stripMarker, markerFor } from "@/lib/collect/marker";

/** Feed a reply to the stream filter in pieces of `size` characters. */
function streamed(text, size) {
  const filter = createMarkerFilter();
  let out = "";
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
  out += filter.end();
  return { text: out, type: filter.type };
}

describe("the start marker never reaches the customer", () => {
  const REAL_CALL =
    "We can help with that pain right away. For a severe toothache we offer a same-day emergency appointment, and there is an extra fee of one thousand rupees on top of the treatment cost. [[START code]]May I have your name, please?";

  test("a marker in the MIDDLE of a reply (the real call) is removed, whole or streamed", () => {
    const expected = "We can help with that pain right away. For a severe toothache we offer a same-day emergency appointment, and there is an extra fee of one thousand rupees on top of the treatment cost. May I have your name, please?";
    assert.equal(stripMarker(REAL_CALL).text, expected);
    for (const size of [1, 2, 3, 4, 7, 11, 50, 400]) assert.equal(streamed(REAL_CALL, size).text, expected, `chunk size ${size}`);
  });

  test("a marker at the start is removed, and its code is reported", () => {
    assert.deepEqual(stripMarker("[[START appointment]] Of course. May I have your name?"), { text: "Of course. May I have your name?", type: "appointment" });
    assert.deepEqual(stripMarker("  [[ start callback ]]Sure."), { text: "Sure.", type: "callback" });
    for (const size of [1, 3, 5]) assert.deepEqual(streamed("[[START appointment]] Of course.", size), { text: "Of course.", type: "appointment" });
  });

  test("a marker at the end, a doubled marker and a single-bracket variant are removed too", () => {
    assert.equal(stripMarker("Sure, one moment. [[START appointment]]").text, "Sure, one moment. ");
    assert.equal(stripMarker("[[START appointment]][[START appointment]]Hello.").text, "Hello.");
    assert.deepEqual(stripMarker("[START appointment] Hello."), { text: "Hello.", type: "appointment" });
  });

  test("the code word is reported as written, so the caller can refuse an unknown one", () => {
    assert.equal(stripMarker("[[START code]]Hi").type, "code");
    assert.equal(stripMarker("[[START]]Hi").type, null);
  });

  test("ordinary brackets and text pass through untouched, at any chunk size", () => {
    for (const text of ["Plan A [see page 3] costs 50.", "Use [[double]] brackets", "Price: [50] rupees", "No brackets at all.", "a [ lone bracket", "ends with [", "[[START"]) {
      for (const size of [1, 2, 6, 100]) assert.equal(streamed(text, size).text, text, `${text} / ${size}`);
      assert.equal(stripMarker(text).type, null, text);
    }
  });

  test("text without a marker is not delayed", () => {
    const filter = createMarkerFilter();
    assert.equal(filter.push("Hello there. "), "Hello there. ");
    assert.equal(filter.push("How can I help?"), "How can I help?");
  });

  test("the prompt's marker is always a real code", () => {
    assert.equal(markerFor("appointment"), "[[START appointment]]");
    assert.equal(stripMarker(markerFor("callback")).type, "callback");
  });
});
