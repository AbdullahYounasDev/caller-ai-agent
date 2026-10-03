import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress, checkUrl, htmlToText, pagesToDocument } from "@/lib/agent/crawl";

// Every checkUrl case here uses a LITERAL IP or a scheme that is refused before any
// lookup, so nothing touches DNS or the network.

describe("isBlockedAddress (§6.9)", () => {
  test("IPv4 private, loopback, link-local/metadata, CGNAT, this-network and multicast are blocked", () => {
    for (const ip of [
      "0.0.0.0", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.0.9",
      "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.168.255.255", "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255",
    ]) assert.equal(isBlockedAddress(ip), true, ip);
  });

  test("neighbouring PUBLIC ranges are not blocked (no over-blocking at the edges)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "192.167.0.1", "11.0.0.1", "223.255.255.255"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  test("malformed IPv4 fails CLOSED", () => {
    for (const ip of ["1.2.3", "a.b.c.d", "", "1.2.3.4.5"]) assert.equal(isBlockedAddress(ip), true, ip);
  });

  test("IPv6 loopback, unspecified, unique-local and link-local are blocked", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "FE80::ABCD"]) assert.equal(isBlockedAddress(ip), true, ip);
  });

  test("IPv6 link-local is the whole fe80::/10, not just the fe80 prefix", () => {
    for (const ip of ["fe90::1", "fea0::1", "febf::1"]) assert.equal(isBlockedAddress(ip), true, ip);
  });

  test("IPv4-mapped IPv6 is judged by the embedded IPv4 address — dotted AND hex spellings", () => {
    assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
    assert.equal(isBlockedAddress("::ffff:169.254.169.254"), true);
    assert.equal(isBlockedAddress("::ffff:7f00:1"), true, "hex form of 127.0.0.1");
    assert.equal(isBlockedAddress("::ffff:a9fe:a9fe"), true, "hex form of 169.254.169.254");
    assert.equal(isBlockedAddress("0:0:0:0:0:ffff:7f00:1"), true, "expanded form");
    assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
    assert.equal(isBlockedAddress("::ffff:808:808"), false);
  });

  test("tunnelled IPv4 (NAT64, 6to4, IPv4-compatible) is judged by the embedded address", () => {
    assert.equal(isBlockedAddress("64:ff9b::7f00:1"), true, "NAT64 of 127.0.0.1");
    assert.equal(isBlockedAddress("64:ff9b::808:808"), false, "NAT64 of 8.8.8.8");
    assert.equal(isBlockedAddress("2002:7f00:1::"), true, "6to4 of 127.0.0.1");
    assert.equal(isBlockedAddress("2002:808:808::"), false);
    assert.equal(isBlockedAddress("::7f00:1"), true, "IPv4-compatible 127.0.0.1");
  });

  test("a zone id does not smuggle a link-local address past the check", () => {
    assert.equal(isBlockedAddress("fe80::1%eth0"), true);
  });

  test("public IPv6 and multicast", () => {
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
    assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
    assert.equal(isBlockedAddress("ff02::1"), true);
  });
});

describe("checkUrl — vectors refused without any network", () => {
  const reason = async (u) => {
    const r = await checkUrl(u);
    assert.equal(r.ok, false, u);
    return r.reason;
  };

  test("only http(s): file, ftp, gopher, data, javascript and garbage are invalidUrl", async () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/x", "gopher://127.0.0.1:70/", "data:text/html,x", "javascript:alert(1)", "not a url", "", "   "]) {
      assert.equal(await reason(u), "invalidUrl", u);
    }
  });

  test("cloud metadata, loopback and the private ranges are blockedAddress", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/", "https://169.254.169.254/", "http://127.0.0.1/", "http://127.0.0.1:5432/",
      "http://10.0.0.5/", "http://192.168.1.1/admin", "http://172.16.0.1/", "http://172.31.255.255/", "http://0.0.0.0/",
    ]) assert.equal(await reason(u), "blockedAddress", u);
  });

  test("alternative IPv4 spellings are normalised by URL parsing and still blocked", async () => {
    for (const u of ["http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://0177.0.0.1/", "http://user:pw@127.0.0.1/", "http://0xa9fea9fe/"]) {
      assert.equal(await reason(u), "blockedAddress", u);
    }
  });

  test("bracketed IPv6 literals are judged by ADDRESS, not by a failed DNS lookup of '[::1]'", async () => {
    for (const u of ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[::ffff:169.254.169.254]/"]) {
      assert.equal(await reason(u), "blockedAddress", u);
    }
  });

  test("a public literal IP passes and the verdict carries the address to pin the connection to", async () => {
    const r = await checkUrl("https://93.184.216.34/page");
    assert.equal(r.ok, true);
    assert.equal(r.address, "93.184.216.34");
    assert.equal(r.url.href, "https://93.184.216.34/page");
    const v6 = await checkUrl("https://[2606:4700:4700::1111]/");
    assert.equal(v6.ok, true);
    assert.equal(v6.address, "2606:4700:4700::1111");
  });
});

describe("htmlToText", () => {
  test("non-prose elements disappear: script, style, noscript, svg, nav, footer, header, comments", () => {
    const html = `<header>HEADER</header><nav>NAV</nav><script>var x="</p>SCRIPT";</script><style>.a{}STYLE</style>
      <noscript>NOSCRIPT</noscript><svg><text>SVG</text></svg><!-- COMMENT --><p>Real content.</p><footer>FOOTER</footer>`;
    assert.equal(htmlToText(html), "Real content.");
  });

  test("headings become markdown # at the right level so the chunker can split on them", () => {
    const text = htmlToText("<h1>Title</h1><p>Intro</p><h2>Sub <b>head</b></h2><p>Body</p><h3>Deep</h3>");
    assert.match(text, /^# Title\n\nIntro\n\n## Sub head\n\nBody\n\n### Deep$/);
  });

  test("a table row stays on one line with cells separated, so a price keeps its service", () => {
    const text = htmlToText("<table><tr><td>Whitening</td><td>250 euros</td></tr><tr><td>Cleaning</td><td>80 euros</td></tr></table>");
    assert.deepEqual(text.split("\n").filter(Boolean), ["Whitening — 250 euros", "Cleaning — 80 euros"]);
  });

  test("list items become bullets and <br> a newline", () => {
    assert.equal(htmlToText("<ul><li>One</li><li>Two</li></ul>a<br>b"), "• One\n• Two\n\na\nb");
  });

  test("entities: named, decimal and hex, and no double-decoding", () => {
    assert.equal(htmlToText("<p>Tom &amp; Jerry &euro;5 &#169; &#x20AC; caf&eacute;</p>"), "Tom & Jerry €5 © € café");
    assert.equal(htmlToText("<p>&amp;lt;b&amp;gt; &amp;#65;</p>"), "&lt;b&gt; &#65;", "&amp; decodes once only");
    assert.equal(htmlToText("<p>&unknownthing; stays</p>"), "&unknownthing; stays");
  });

  test("HOSTILE: an out-of-range numeric entity must not throw and abort the crawl", () => {
    for (const bad of ["&#99999999999;", "&#1114112;", "&#xFFFFFFFF;", "&#55296;"]) {
      let out;
      assert.doesNotThrow(() => (out = htmlToText(`<p>before ${bad} after</p>`)), bad);
      assert.match(out, /before .*after/);
    }
  });

  test("whitespace is normalised; nullish gives empty", () => {
    assert.equal(htmlToText("<p>  a \t b  </p>\n\n\n\n<p>c</p>"), "a b\n\nc");
    assert.equal(htmlToText(null), "");
    assert.equal(htmlToText(undefined), "");
  });

  test("tags with attributes and mixed case are handled; script close tags are matched case-insensitively", () => {
    assert.equal(htmlToText(`<SCRIPT type="x">bad()</SCRIPT><P class="a">ok</P>`), "ok");
  });
});

describe("pagesToDocument", () => {
  test("each page becomes its own # section carrying its source URL", () => {
    const doc = pagesToDocument([
      { title: "Home", url: "https://x.test/", text: "Welcome." },
      { title: "Prices", url: "https://x.test/p", text: "Cheap." },
    ]);
    assert.equal(doc, "# Home\n\nSource: https://x.test/\n\nWelcome.\n\n# Prices\n\nSource: https://x.test/p\n\nCheap.");
  });
});
