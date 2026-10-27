import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { toE164, routeForNumber, ROUTE_REFUSALS } from "@/lib/telephony/routing";
import { readRoute, rememberRoute, forgetRoute } from "@/lib/telephony/route-cache";
import { issueTicket, createTicketVerifier } from "@/lib/voice/ticket";
import { voiceLine } from "@/lib/agent/prompt";

// The phone-number lookup (CLAUDE.md §6.29): the pure rules. The database half — the stand-in
// store, the seam, re-linking, releasing, isolation — is `npm run test:numbers`.

describe("a dialled number in international form", () => {
  test("E.164 as a provider sends it, and as people type it", () => {
    for (const [raw, want] of [
      ["+442071234567", "+442071234567"],
      ["+44 20 7123 4567", "+442071234567"],
      ["+44 (0)20 7123 4567".replace("(0)", ""), "+442071234567"],
      ["0044 20 7123 4567", "+442071234567"],
      ["+353-1-234-5678", "+35312345678"],
      ["+92 300 1234567", "+923001234567"],
      [" +1.415.555.0100 ", "+14155550100"],
    ]) {
      assert.deepEqual(toE164(raw), { ok: true, value: want }, raw);
    }
  });

  test("a number without its country code is refused, never guessed", () => {
    assert.equal(toE164("020 7123 4567").reason, "needsCountryCode");
    assert.equal(toE164("0300 1234567").reason, "needsCountryCode");
  });

  test("junk is refused: letters, extensions, a second +, a 0 country code, too short or long", () => {
    for (const raw of ["call me", "+44 20 7123 4567 x12", "++442071234567", "+44+2071234567", "+0442071234567", "+1234", "+1234567890123456"]) {
      assert.equal(toE164(raw).ok, false, raw);
    }
    assert.equal(toE164("").reason, "empty");
    assert.equal(toE164(null).reason, "empty");
  });
});

describe("who answers a number", () => {
  const row = (extra) => ({ id: "n1", tenantId: "chain", agentId: "dublin", agent: { status: "active" }, ...extra });

  test("an active number linked to an active agent → that tenant and that agent", () => {
    assert.deepEqual(routeForNumber({ active: row() }), { ok: true, tenantId: "chain", agentId: "dublin", numberId: "n1" });
  });

  test("every refusal has its own reason, and none is a guess", () => {
    assert.equal(routeForNumber({ active: null }).reason, "unknown");
    assert.equal(routeForNumber({ active: null, everHeld: true }).reason, "released");
    assert.equal(routeForNumber({ active: row({ agentId: null, agent: null }) }).reason, "unassigned");
    assert.equal(routeForNumber({ active: row({ agent: { status: "archived" } }) }).reason, "agent_archived");
    for (const r of ["unknown", "released", "unassigned", "agent_archived"]) assert.ok(ROUTE_REFUSALS.includes(r));
  });

  test("a refusal for a known number still says whose it is (for the call log), never which agent", () => {
    const refused = routeForNumber({ active: row({ agent: { status: "archived" } }) });
    assert.equal(refused.tenantId, "chain");
    assert.equal(refused.numberId, "n1");
    assert.equal(refused.agentId, undefined);
  });
});

describe("the route cache", () => {
  test("remembered for a while, then forgotten; a change forgets it at once", () => {
    forgetRoute();
    rememberRoute("+441", { ok: true }, 1_000);
    assert.deepEqual(readRoute("+441", 1_000 + 29_999), { ok: true });
    assert.equal(readRoute("+441", 1_000 + 30_001), undefined, "expired after 30 s");
    rememberRoute("+442", { ok: true }, 0);
    forgetRoute("+442");
    assert.equal(readRoute("+442", 1), undefined);
  });
});

describe("the voice ticket carries the line", () => {
  const secret = "test-secret";

  test("a call 'as if dialling' a number keeps that number, signed", () => {
    const verifier = createTicketVerifier({ secret });
    const line = { numberId: "n1", toNumber: "+442071234567" };
    const { ticket } = issueTicket({ tenantId: "chain", agentId: "dublin", line, ttlMs: 60_000, secret });
    assert.deepEqual(verifier.verify(ticket), { ok: true, tenantId: "chain", agentId: "dublin", line: { ...line, fromNumber: null }, resume: null });
  });

  test("a phone call also keeps who is calling, signed", () => {
    const verifier = createTicketVerifier({ secret });
    const line = { numberId: "n1", toNumber: "+442071234567", fromNumber: "+923001234567" };
    const { ticket } = issueTicket({ tenantId: "chain", agentId: "dublin", line, ttlMs: 60_000, secret });
    assert.deepEqual(verifier.verify(ticket).line, line);
    const [payload, sig] = ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), f: "+10000000000" })).toString("base64url");
    assert.equal(createTicketVerifier({ secret }).verify(`${forged}.${sig}`).reason, "signature");
  });

  test("the number cannot be changed in the browser", () => {
    const verifier = createTicketVerifier({ secret });
    const [payload, sig] = issueTicket({ tenantId: "chain", agentId: "dublin", line: { numberId: "n1", toNumber: "+442071234567" }, ttlMs: 60_000, secret }).ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), d: "+449999999999" })).toString("base64url");
    assert.equal(verifier.verify(`${forged}.${sig}`).reason, "signature");
  });

  test("a plain console call has no line", () => {
    const verifier = createTicketVerifier({ secret });
    assert.equal(verifier.verify(issueTicket({ tenantId: "t", ttlMs: 60_000, secret }).ticket).line, null);
  });
});

test("a caller to a number that rings nobody hears a plain line in both languages", () => {
  assert.match(voiceLine("not_in_service", "en"), /not in service/);
  assert.ok(voiceLine("not_in_service", "ur").length > 10);
});
