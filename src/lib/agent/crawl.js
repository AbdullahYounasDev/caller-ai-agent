/**
 * WEBSITE CRAWLING — turn a business's own pages into knowledge.
 *
 * Most small businesses already have their hours, prices and policies written
 * down: on their website. Asking them to re-type it into a text box is the
 * single biggest reason a knowledge base stays empty. Pointing at a URL is the
 * shortest path from "signed up" to "the agent actually knows things".
 *
 * ── THIS FETCHES URLS A STRANGER SUPPLIES, SO IT IS HOSTILE INPUT ────────
 * A naive implementation here is a Server-Side Request Forgery: a tenant types
 * `http://169.254.169.254/latest/meta-data/` and our server obligingly fetches
 * cloud credentials and stores them as "knowledge" they can then read back by
 * asking their own agent. Or `http://localhost:5432`, or a router's admin page.
 *
 * Every defence below exists for that:
 *   - https/http only — no file:, data:, gopher:, ftp:
 *   - the resolved IP is checked against private and reserved ranges, and
 *     checked AGAIN after each redirect, because a public hostname can redirect
 *     to 127.0.0.1 and a check done only on the first URL would miss it
 *   - redirects are followed manually for that reason, and bounded
 *   - responses are size-capped and time-capped
 *   - only HTML and plain text are read
 * ─────────────────────────────────────────────────────────────────────────
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
// Node's global fetch() is backed by its OWN bundled undici — mixing it with
// an Agent from the separately installed `undici` package fails outright
// ("invalid onRequestStart method"), because the two copies' internal Request
// shapes don't match. Importing fetch from the SAME package as Agent keeps
// them compatible.
import { Agent, fetch } from "undici";

/** Per page. Enough for a long policy page, far below what would exhaust memory. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Whole-crawl ceiling, so one site cannot run for minutes. */
const MAX_PAGES = 25;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** Below this, a DISCOVERED page is treated as a stub and skipped. The page the
 *  business actually typed is exempt — see crawlSite. */
const MIN_PAGE_CHARS = 200;

/** Identify ourselves honestly. A site owner reading their logs should be able
 *  to tell who we are and why we came. */
const USER_AGENT =
  "CallerAIAgent/1.0 (+website knowledge indexing; contact the site owner who enabled this)";

/**
 * Private, loopback, link-local and reserved ranges. The link-local block in
 * particular (169.254.0.0/16) is where every major cloud puts its instance
 * metadata service — the highest-value target for an SSRF and the reason this
 * list is not optional.
 */
function isBlockedAddress(ip) {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique local
    if (v6.startsWith("fe80")) return true; // link-local
    // IPv4-mapped (::ffff:127.0.0.1) — check the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;

  if (a === 0) return true; // this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Is this URL safe to fetch?
 *
 * Returns the resolved ADDRESS along with the verdict — not just so the
 * decision was made on an address rather than a name that could be anything,
 * but so the caller can PIN the actual connection to that exact address (see
 * fetchPage). Checking the address here and then handing fetch() the hostname
 * to resolve AGAIN, milliseconds later, is a DNS-rebinding gap: a hostile DNS
 * server can answer this lookup with a safe public IP and the next one with
 * 127.0.0.1, and nothing here would ever see the second answer.
 *
 * @returns {Promise<{ok: true, url: URL, address: string} | {ok: false, reason: string}>}
 */
export async function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: "invalidUrl" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalidUrl" };
  }

  // Resolve the hostname ourselves so the decision is made on the ADDRESS, not
  // on a name that could be anything. A literal IP is checked directly.
  let address;
  try {
    address = isIP(url.hostname) ? url.hostname : (await lookup(url.hostname)).address;
    if (isBlockedAddress(address)) return { ok: false, reason: "blockedAddress" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  return { ok: true, url, address };
}

/**
 * Fetch one page, following redirects MANUALLY so every hop is re-validated.
 *
 * `redirect: "manual"` is the point: with the default the runtime follows hops
 * itself and a public hostname redirecting to 127.0.0.1 would be fetched before
 * we ever saw it.
 *
 * THE CONNECTION IS PINNED TO THE ADDRESS checkUrl() JUST VALIDATED. Global
 * fetch() is undici underneath, and left to its own devices it re-resolves the
 * hostname itself when it actually connects — a SEPARATE DNS lookup, moments
 * after ours. That gap is a DNS-rebinding hole: a hostile authoritative DNS
 * server can answer our lookup with a safe public IP (passing checkUrl) and
 * fetch()'s with 127.0.0.1 or a cloud metadata address (the actual request).
 * A custom dispatcher with a fixed `lookup` forces the real TCP connection to
 * the EXACT address we checked, so there is no second resolution left to lie
 * to. TLS hostname verification is unaffected — undici still uses the URL's
 * hostname for SNI/certificate checking; only the DNS step is pinned.
 *
 * REDIRECTS ARE PINNED TO THE ORIGIN THAT WAS ASKED FOR. Re-validating each hop
 * against the SSRF blocklist (above) stops a redirect landing on a private
 * address, but says nothing about a redirect to a different PUBLIC site — an
 * open redirect on the business's own site (or a link shortener, or an ad
 * tracker on the page) could otherwise hand the crawler off to an unrelated
 * domain, which then gets ingested as if it were the business's own content.
 * "A business asked us to read THEIR site" is already the rule for links
 * discovered on the page (linksFrom, below); it applies here too.
 */
async function fetchPage(url) {
  let current = url;
  const requestedOrigin = url.origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(current.href);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    // One-shot Agent per hop, scoped to the address THIS hop's checkUrl() just
    // validated — the pinning has to be per-hop because a redirect changes
    // the target (and same-origin doesn't mean same IP). Not closed until the
    // very end of this hop's handling (the `finally` below) — closing it
    // right after the headers arrive, before the body is read, risks tearing
    // down the connection mid-stream.
    const dispatcher = new Agent({
      connect: {
        // Node's connect logic requests the array form (`{ all: true }`, RFC
        // 8305 "Happy Eyeballs") as well as the classic single-address form
        // depending on path taken — both must return the SAME pinned address.
        lookup: (_hostname, options, callback) => {
          const family = isIP(verdict.address);
          if (options?.all) {
            callback(null, [{ address: verdict.address, family }]);
          } else {
            callback(null, verdict.address, family);
          }
        },
      },
    });

    try {
      let res;
      try {
        res = await fetch(current.href, {
          redirect: "manual",
          signal: controller.signal,
          dispatcher,
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9" },
        });
      } catch {
        return { ok: false, reason: "unreachable" };
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, reason: "unreachable" };
        const next = new URL(location, current);
        if (next.origin !== requestedOrigin) {
          return { ok: false, reason: "crossOriginRedirect" };
        }
        current = next;
        continue;
      }

      if (!res.ok) return { ok: false, reason: "httpError", status: res.status };

      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!type.includes("text/html") && !type.includes("text/plain")) {
        // A PDF linked from a page is a legitimate document, but it belongs in
        // the upload path where it is parsed properly — not silently binary-read
        // here and stored as gibberish.
        return { ok: false, reason: "notHtml" };
      }

      // Declared length first, then enforced while reading — a server can lie
      // about or omit Content-Length.
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared && declared > MAX_PAGE_BYTES) return { ok: false, reason: "tooLarge" };

      const reader = res.body?.getReader();
      if (!reader) return { ok: false, reason: "unreachable" };

      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_PAGE_BYTES) {
          await reader.cancel();
          return { ok: false, reason: "tooLarge" };
        }
        parts.push(value);
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }

      return {
        ok: true,
        url: current,
        html: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }

  return { ok: false, reason: "tooManyRedirects" };
}

/**
 * HTML → text, keeping the structure the chunker relies on.
 *
 * Written by hand rather than with a DOM parser because the job is narrow and
 * a dependency that parses hostile HTML is a larger surface than a few regexes
 * that only ever produce a string. Headings become Markdown `#` so
 * chunk.js can split on them — which is the whole reason not to just strip tags.
 */
export function htmlToText(html) {
  let text = String(html ?? "");

  // Everything that is not prose. Nav and footer go too: repeated on every page,
  // they would dominate a small site's embeddings with menu items.
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Headings → Markdown, so the heading-aware chunker can use them.
  for (let level = 1; level <= 6; level++) {
    text = text.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"),
      (_m, inner) => `\n\n${"#".repeat(level)} ${stripTags(inner)}\n\n`
    );
  }

  // Table rows become one line with cells separated — a price table flattened
  // into prose loses which number belongs to which service.
  text = text
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " — ")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|tr|table|ul|ol)>/gi, "\n\n");

  return normalizeText(stripTags(text));
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    eacute: "é", egrave: "è", agrave: "à", ograve: "ò", ugrave: "ù",
    hellip: "…", mdash: "—", ndash: "–", euro: "€", pound: "£", deg: "°",
  };
  return value
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function normalizeText(value) {
  return decodeEntities(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The page's <title>, used to name the document. */
function titleOf(html, url) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? normalizeText(stripTags(match[1])) : "";
  return title || url.hostname + url.pathname;
}

/**
 * Same-site links worth following.
 *
 * SAME ORIGIN ONLY. A business asked us to read THEIR site; following outbound
 * links would wander onto sites nobody consented to us crawling, and fill their
 * knowledge base with someone else's content.
 */
function linksFrom(html, base) {
  const out = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    let href = match[1].trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;

    let url;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;

    // Assets masquerading as pages.
    if (/\.(jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3|woff2?)$/i.test(url.pathname)) continue;

    // The fragment is the same page; the query usually is too (filters, sort
    // orders, session ids) and following it multiplies near-identical pages.
    url.hash = "";
    url.search = "";
    out.add(url.href);
  }
  return [...out];
}

/**
 * Crawl a site starting at `startUrl`.
 *
 * @param {object} args
 * @param {string} args.startUrl
 * @param {number} [args.maxPages]
 * @param {boolean} [args.followLinks] false = just this one page
 * @returns {Promise<{ok: true, pages: Array<{url: string, title: string, text: string}>}
 *                 | {ok: false, reason: string, status?: number}>}
 */
export async function crawlSite({ startUrl, maxPages = 10, followLinks = true, onProgress }) {
  const first = await checkUrl(startUrl);
  if (!first.ok) return { ok: false, reason: first.reason };

  const limit = Math.min(Math.max(1, maxPages), MAX_PAGES);
  const queue = [first.url.href];
  const seen = new Set(queue);
  const pages = [];

  while (queue.length && pages.length < limit) {
    const next = queue.shift();
    const result = await fetchPage(new URL(next));

    // ONE BAD PAGE MUST NOT FAIL THE CRAWL. A 404 on a stale link is normal on
    // a real site, and refusing everything because of it would make this
    // unusable — but a failure on the STARTING page is worth reporting, since
    // that is the address the business actually typed.
    if (!result.ok) {
      if (pages.length === 0 && next === first.url.href) {
        return { ok: false, reason: result.reason, status: result.status };
      }
      continue;
    }

    const text = htmlToText(result.html);

    // Skip near-empty pages: image galleries, redirect stubs, "loading…"
    // shells. Embedding them adds noise that competes with real answers.
    //
    // THE STARTING PAGE IS EXEMPT. The business typed that address on purpose,
    // and a deliberately short page — a one-paragraph contact or hours page —
    // is exactly the kind of thing worth knowing. Applying the filter to it
    // made a perfectly good crawl fail with "no readable text" for a page we
    // had in fact read.
    const isStartPage = next === first.url.href;
    if (isStartPage ? text.length > 0 : text.length >= MIN_PAGE_CHARS) {
      pages.push({ url: result.url.href, title: titleOf(result.html, result.url), text });
    }

    // Reported against the CEILING, not the queue length: the queue grows as
    // links are discovered, and a bar whose denominator keeps rising looks
    // like it is going backwards.
    await onProgress?.(pages.length, limit);

    if (followLinks && pages.length < limit) {
      for (const link of linksFrom(result.html, result.url)) {
        if (!seen.has(link)) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
  }

  if (!pages.length) return { ok: false, reason: "noText" };
  return { ok: true, pages };
}

/**
 * Fold crawled pages into ONE document.
 *
 * Why one document rather than one per page: re-crawling a site should replace
 * what was there before, and per-page documents would strand a record for every
 * page that has since been deleted or renamed. One document per site means a
 * re-crawl is an ordinary replace — the same rule as every other ingest path.
 *
 * Each page keeps its title as a heading, so chunk.js still splits per page and
 * retrieval can cite the section it came from.
 */
export function pagesToDocument(pages) {
  return pages
    .map((page) => `# ${page.title}\n\nSource: ${page.url}\n\n${page.text}`)
    .join("\n\n");
}
