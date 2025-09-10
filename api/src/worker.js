// api/src/worker.js
import { URL } from 'node:url';
import { promises as dns } from 'node:dns';
import * as punycode from 'node:punycode';
import PQueue from 'p-queue';
import got from 'got';
import * as cheerio from 'cheerio';
import RobotsParser from 'robots-txt-parser';
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeUrl = (base, href) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

/**
 * Heuristics for parked/for-sale landers. Extend as needed.
 */
const parkedPhrases = [
  'domain for sale',
  'buy this domain',
  'this domain is parked',
  'sedo',
  'dan.com',
  'afternic',
  'parkingcrew',
  'bodis',
  'hugedomains',
];

/**
 * If your local resolver is flaky, you can force public resolvers:
 * (Uncomment to enable)
 *
 * dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
 */

/**
 * Robust DNS presence check:
 * - Try dns.lookup (follows CNAME, uses OS resolver)
 * - Try A and AAAA
 * - If CNAME exists, resolve its target A/AAAA
 * Returns { hasDns: boolean, nxDomain: boolean, detail?: object }
 */
async function dnsHasAddresses(domain) {
  const detail = { steps: {} };

  // 1) OS-level lookup (most tolerant; follows CNAME)
  try {
    const addrs = await dns.lookup(domain, { all: true, verbatim: false });
    detail.steps.lookup = addrs;
    if (Array.isArray(addrs) && addrs.length > 0) {
      return { hasDns: true, nxDomain: false, detail };
    }
  } catch (e) {
    detail.steps.lookupError = e?.code || e?.message || String(e);
  }

  // 2) A/AAAA
  try {
    const a = await dns.resolve4(domain);
    detail.steps.resolve4 = a;
    if (a && a.length) return { hasDns: true, nxDomain: false, detail };
  } catch (e) {
    detail.steps.resolve4Error = e?.code || e?.message || String(e);
  }

  try {
    const aaaa = await dns.resolve6(domain);
    detail.steps.resolve6 = aaaa;
    if (aaaa && aaaa.length) return { hasDns: true, nxDomain: false, detail };
  } catch (e) {
    detail.steps.resolve6Error = e?.code || e?.message || String(e);
  }

  // 3) CNAME -> resolve target
  try {
    const cn = await dns.resolveCname(domain);
    detail.steps.cname = cn;
    if (cn && cn.length) {
      const target = cn[0];
      try {
        const ta = await dns.resolve4(target);
        detail.steps.cnameResolve4 = ta;
        if (ta && ta.length) return { hasDns: true, nxDomain: false, detail };
      } catch (e) {
        detail.steps.cnameResolve4Error = e?.code || e?.message || String(e);
      }
      try {
        const taaaa = await dns.resolve6(target);
        detail.steps.cnameResolve6 = taaaa;
        if (taaaa && taaaa.length) return { hasDns: true, nxDomain: false, detail };
      } catch (e) {
        detail.steps.cnameResolve6Error = e?.code || e?.message || String(e);
      }
    }
  } catch (e) {
    detail.steps.cnameError = e?.code || e?.message || String(e);
  }

  // Distinguish NXDOMAIN vs. inconclusive errors using resolveAny last
  try {
    const anyRec = await dns.resolveAny(domain);
    detail.steps.resolveAny = anyRec;
    if (anyRec && anyRec.length) {
      return { hasDns: true, nxDomain: false, detail };
    }
  } catch (e) {
    const code = e?.code || '';
    detail.steps.resolveAnyError = code;
    if (code === 'NXDOMAIN' || code === 'ENOTFOUND') {
      return { hasDns: false, nxDomain: true, detail };
    }
    // ENODATA/SERVFAIL/REFUSED/EAI_AGAIN are inconclusive
  }

  return { hasDns: false, nxDomain: false, detail };
}

async function fetchWithHeuristics(domain, events) {
  const tryFetch = async (proto) => {
    const url = `${proto}://${domain}`;
    events?.emit('progress', { type: 'domain', stage: `fetch-${proto}-start`, domain });
    const res = await got(url, {
      method: 'GET',
      timeout: { request: 9000 },
      followRedirect: true,
      http2: true,
      retry: { limit: 0 },
    });
    const body = (res.body || '').slice(0, 5000).toLowerCase();
    const parked = parkedPhrases.some((p) => body.includes(p));
    events?.emit('progress', {
      type: 'domain',
      stage: `fetch-${proto}-ok`,
      domain,
      statusCode: res.statusCode,
      parked,
    });
    return { ok: true, statusCode: res.statusCode, parked };
  };

  // Prefer HTTPS first
  try {
    return await tryFetch('https');
  } catch (e) {
    events?.emit('progress', {
      type: 'domain',
      stage: 'fetch-https-error',
      domain,
      error: e?.code || e?.message || String(e),
    });
  }

  // Fallback to HTTP
  try {
    return await tryFetch('http');
  } catch (e) {
    events?.emit('progress', {
      type: 'domain',
      stage: 'fetch-http-error',
      domain,
      error: e?.code || e?.message || String(e),
    });
    const code = e?.code || '';
    return { ok: false, error: code || 'HTTP_ERROR' };
  }
}

/**
 * checkDomain(domain, events)
 * Emits detailed stages and returns { status, ... }
 *
 * status:
 *  - 'no-dns'     : conclusive NXDOMAIN/ENOTFOUND
 *  - 'ok'         : HTTP(S) responded (with `httpStatus`, `parked`)
 *  - 'http-error' : DNS present but HTTP failed (server/SSL/down)
 *  - 'dns-error'  : inconclusive DNS issues (not NXDOMAIN)
 */
async function checkDomain(domain, events) {
  const asciiDomain = domain.includes('xn--') ? domain : punycode.toASCII(domain);

  events?.emit('progress', { type: 'domain', stage: 'dns-start', domain: asciiDomain });
  let dnsResult;
  try {
    dnsResult = await dnsHasAddresses(asciiDomain);
  } catch (e) {
    dnsResult = { hasDns: false, nxDomain: false, detail: { fatal: e?.message || String(e) } };
  }
  events?.emit('progress', {
    type: 'domain',
    stage: 'dns-result',
    domain: asciiDomain,
    detail: dnsResult.detail || {},
    hasDns: dnsResult.hasDns,
    nxDomain: dnsResult.nxDomain,
  });

  if (!dnsResult.hasDns && dnsResult.nxDomain) {
    return { status: 'no-dns', code: 'NXDOMAIN' };
  }

  if (!dnsResult.hasDns && !dnsResult.nxDomain) {
    // inconclusive DNS (ENODATA/SERVFAIL/REFUSED/etc.) → don't call it expired;
    // try fetch anyway; many hosts have odd DNS setups but still serve HTTPS.
  }

  const httpRes = await fetchWithHeuristics(asciiDomain, events);
  if (httpRes.ok) {
    return { status: 'ok', httpStatus: httpRes.statusCode, parked: httpRes.parked };
  }

  // If we get here: DNS may exist but fetch failed.
  // Distinguish between inconclusive DNS vs HTTP-level failure.
  if (!dnsResult.hasDns && !dnsResult.nxDomain) {
    return { status: 'dns-error', code: 'INCONCLUSIVE_DNS' };
  }
  return { status: 'http-error', code: httpRes.error || 'HTTP_ERROR' };
}

export function createCrawler({ startUrl, maxPages = 500, concurrency = 5, events = bus }) {
  const origin = new URL(startUrl).origin;
  const visited = new Set();
  const foundOutbound = new Map(); // domain => { domain, urls:Set, pages:Set, result }

  const robots = RobotsParser({
    robotsUrl: new URL('/robots.txt', origin).toString(),
    allowOnNeutral: true,
  });

  const queue = new PQueue({ concurrency });

  // --- Stats ticker (progress + ETA) ---
  let checkedDomains = 0;
  let statsTimer = null;
  function startStats() {
    if (statsTimer) return;
    const t0 = Date.now();
    let lastVisited = 0;
    let lastTime = t0;

    statsTimer = setInterval(() => {
      const now = Date.now();
      const dv = visited.size - lastVisited;
      const dt = (now - lastTime) / 1000;
      const crawlRate = dt > 0 ? dv / dt : 0; // pages/sec
      lastVisited = visited.size;
      lastTime = now;

      const pagesRemaining = Math.max(0, maxPages - visited.size - queue.size);
      const etaSec = crawlRate > 0 ? pagesRemaining / crawlRate : null;

      events.emit('progress', {
        type: 'stats',
        visited: visited.size,
        inQueue: queue.size,
        checkedDomains,
        maxPages,
        concurrency,
        crawlRate, // pages per second
        etaSec, // may be null early on
      });
    }, 1000);
  }

  async function crawl(url) {
    if (visited.size >= maxPages) return;
    if (visited.has(url)) return;
    visited.add(url);

    startStats();
    events.emit('progress', { type: 'page', stage: 'enqueue', url, visited: visited.size });

    // Robots check (informative)
    try {
      events.emit('progress', { type: 'page', stage: 'robots-check', url });
      const allowed = await robots.canCrawl(url, 'ExpiredBot');
      if (!allowed) {
        events.emit('progress', { type: 'page', stage: 'robots-disallow', url });
        return;
      }
    } catch (e) {
      events.emit('progress', { type: 'page', stage: 'robots-error', url, error: e?.message || String(e) });
    }

    // Fetch page and parse links
    try {
      events.emit('progress', { type: 'page', stage: 'fetch-start', url });
      const res = await got(url, { timeout: { request: 10000 }, followRedirect: true });
      events.emit('progress', { type: 'page', stage: 'fetch-ok', url, status: res.statusCode });

      const $ = cheerio.load(res.body);
      const links = new Set();
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        const abs = normalizeUrl(url, href);
        if (abs) links.add(abs);
      });
      events.emit('progress', { type: 'page', stage: 'parse-links', url, linkCount: links.size });

      for (const l of links) {
        const u = new URL(l);
        if (u.origin === origin) {
          // Internal: schedule crawl
          if (!visited.has(l) && visited.size + queue.size < maxPages) {
            queue.add(() => crawl(l));
          }
        } else {
          // External: track by domain
          const domain = u.hostname;
          if (!foundOutbound.has(domain)) {
            foundOutbound.set(domain, {
              domain,
              urls: new Set([l]),
              pages: new Set([url]),
              result: null,
            });

            queue.add(async () => {
              events.emit('progress', { type: 'domain', stage: 'check-start', domain });
              const result = await checkDomain(domain, events);
              checkedDomains += 1;
              const rec = foundOutbound.get(domain);
              if (rec) rec.result = result;
              events.emit('progress', { type: 'domain', stage: 'check-done', domain, result });
            });
          } else {
            const rec = foundOutbound.get(domain);
            rec.urls.add(l);
            rec.pages.add(url);
          }
        }
      }

      // Be polite
      await sleep(250);
    } catch (err) {
      events.emit('progress', {
        type: 'page',
        stage: 'fetch-error',
        url,
        error: err.message || String(err),
      });
    }
  }

  return {
    async start() {
      events.emit('progress', { type: 'start', startUrl, maxPages, concurrency });
      await crawl(startUrl);
      await queue.onIdle();
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
      // Prepare final payload (returned to the caller if awaited)
      const results = Array.from(foundOutbound.values()).map((v) => ({
        domain: v.domain,
        pages: Array.from(v.pages),
        sampleUrls: Array.from(v.urls).slice(0, 5),
        result: v.result || { status: 'pending' },
      }));
      events.emit('progress', {
        type: 'done',
        totalPages: visited.size,
        domains: results.length,
      });
      return results;
    },
  };
}
