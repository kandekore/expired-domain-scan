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

async function dnsHasAddresses(domain) {
  const detail = { steps: {} };
  try {
    const addrs = await dns.lookup(domain, { all: true, verbatim: false });
    detail.steps.lookup = addrs;
    if (Array.isArray(addrs) && addrs.length > 0) {
      return { hasDns: true, nxDomain: false, detail };
    }
  } catch (e) {
    detail.steps.lookupError = e?.code || e?.message || String(e);
  }
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
    return { ok: true, statusCode: res.statusCode };
  };

  try {
    return await tryFetch('https');
  } catch (e) {
    events?.emit('progress', { type: 'domain', stage: 'fetch-https-error', domain, error: e?.code || e?.message || String(e) });
  }

  try {
    return await tryFetch('http');
  } catch (e) {
    events?.emit('progress', { type: 'domain', stage: 'fetch-http-error', domain, error: e?.code || e?.message || String(e) });
    const code = e?.code || '';
    return { ok: false, error: code || 'HTTP_ERROR' };
  }
}

async function checkDomain(domain, events, resultsCollection, website) {
    const asciiDomain = domain.includes('xn--') ? domain : punycode.toASCII(domain);
  
    events?.emit('progress', { type: 'domain', stage: 'dns-start', domain: asciiDomain });
    let dnsResult;
    try {
      dnsResult = await dnsHasAddresses(asciiDomain);
    } catch (e) {
      dnsResult = { hasDns: false, nxDomain: false, detail: { fatal: e?.message || String(e) } };
    }
    events?.emit('progress', { type: 'domain', stage: 'dns-result', domain: asciiDomain, detail: dnsResult.detail || {}, hasDns: dnsResult.hasDns, nxDomain: dnsResult.nxDomain });
  
    let result;
    if (!dnsResult.hasDns && dnsResult.nxDomain) {
      result = { status: 'no-dns', code: 'NXDOMAIN' };
    } else {
        const httpRes = await fetchWithHeuristics(asciiDomain, events);
        if (httpRes.ok) {
          result = { status: 'ok', httpStatus: httpRes.statusCode };
        } else {
            if (!dnsResult.hasDns && !dnsResult.nxDomain) {
              result = { status: 'dns-error', code: 'INCONCLUSIVE_DNS' };
            } else {
                result = { status: 'http-error', code: httpRes.error || 'HTTP_ERROR' };
            }
        }
    }
  
    if (resultsCollection && result.status === 'no-dns') {
        const tld = asciiDomain.split('.').pop();
        const doc = {
            website,
            domain: asciiDomain,
            tld,
            status: result.status,
            code: result.code,
            foundAt: new Date()
        };
        await resultsCollection.updateOne({ website, domain: asciiDomain }, { $set: doc }, { upsert: true });
    }
  
    return result;
}

export function createCrawler({
    startUrl,
    maxPages: batchSize = 1000,
    concurrency = 5,
    mode,
    events,
    scansCollection,
    resultsCollection
}) {
    const origin = new URL(startUrl).origin;
    const website = new URL(startUrl).hostname;
    
    let visitedThisBatch = new Set();
    let foundOutbound = new Map();

    const robots = RobotsParser({
        robotsUrl: new URL('/robots.txt', origin).toString(),
        allowOnNeutral: true,
    });

    const queue = new PQueue({ concurrency });

    let statsTimer = null;
    function startStats(scanState) {
        if (statsTimer) return;
        let lastVisited = 0;
        let lastTime = Date.now();

        statsTimer = setInterval(() => {
            const now = Date.now();
            const dv = visitedThisBatch.size - lastVisited;
            const dt = (now - lastTime) / 1000;
            const crawlRate = dt > 0 ? dv / dt : 0;
            lastVisited = visitedThisBatch.size;
            lastTime = now;

            const totalVisited = (scanState.visited?.length || 0) + visitedThisBatch.size;
            const etaSec = null; 

            events.emit('progress', {
                type: 'stats',
                visited: totalVisited,
                inQueue: queue.size + scanState.queue.size,
                checkedDomains: scanState.checkedDomains || 0,
                maxPages: 'N/A',
                concurrency,
                crawlRate,
                etaSec,
            });
        }, 1000);
    }

    async function crawl(url, scanState) {
        if (visitedThisBatch.size >= batchSize) return;
        if (scanState.visited.has(url) || visitedThisBatch.has(url)) return;
        
        visitedThisBatch.add(url);

        events.emit('progress', { type: 'page', stage: 'enqueue', url, visited: (scanState.visited?.size || 0) + visitedThisBatch.size });

        try {
            const allowed = await robots.canCrawl(url, 'ExpiredBot');
            if (!allowed) return;
        } catch { /* ignore robots errors */ }

        try {
            const res = await got(url, { timeout: { request: 10000 }, followRedirect: true });
            events.emit('progress', { type: 'page', stage: 'fetch-ok', url, status: res.statusCode });

            const $ = cheerio.load(res.body);
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                const abs = normalizeUrl(url, href);
                if (abs) links.add(abs);
            });

            for (const l of links) {
                const u = new URL(l);
                if (u.origin === origin) {
                    if (!scanState.visited.has(l) && !visitedThisBatch.has(l)) {
                        scanState.queue.add(l);
                    }
                } else {
                    const domain = u.hostname;
                    if (!foundOutbound.has(domain)) {
                        foundOutbound.set(domain, true);
                        queue.add(async () => {
                            events.emit('progress', { type: 'domain', stage: 'check-start', domain });
                            const result = await checkDomain(domain, events, resultsCollection, website);
                            scanState.checkedDomains = (scanState.checkedDomains || 0) + 1;
                            events.emit('progress', { type: 'domain', stage: 'check-done', domain, result });
                        });
                    }
                }
            }
            await sleep(250);
        } catch (err) {
            events.emit('progress', { type: 'page', stage: 'fetch-error', url, error: err.message });
        }
    }

    return {
        async start() {
            let scanStateDoc = await scansCollection.findOne({ website });

            if (mode === 'new' || !scanStateDoc) {
                if (scanStateDoc) {
                    await scansCollection.deleteOne({ website });
                }
                scanStateDoc = {
                    website,
                    startUrl,
                    status: 'running',
                    queue: [startUrl],
                    visited: [],
                    checkedDomains: 0,
                    createdAt: new Date(),
                };
            } else {
                scanStateDoc.status = 'running';
            }
            
            const scanState = {
                ...scanStateDoc,
                queue: new Set(scanStateDoc.queue),
                visited: new Set(scanStateDoc.visited)
            };
            
            startStats(scanState);
            events.emit('progress', { type: 'start', startUrl, batchSize, concurrency, mode });

            while (scanState.queue.size > 0 && visitedThisBatch.size < batchSize) {
                const nextUrl = scanState.queue.values().next().value;
                scanState.queue.delete(nextUrl);
                
                if (!scanState.visited.has(nextUrl) && !visitedThisBatch.has(nextUrl)) {
                    queue.add(() => crawl(nextUrl, scanState));
                }
            }

            await queue.onIdle();
            if (statsTimer) clearInterval(statsTimer);

            const finalVisited = new Set([...scanState.visited, ...visitedThisBatch]);
            const finalQueue = new Set([...scanState.queue]);
            
            const newStatus = finalQueue.size === 0 ? 'completed' : 'paused';

            await scansCollection.updateOne(
                { website },
                {
                    $set: {
                        status: newStatus,
                        queue: Array.from(finalQueue),
                        visited: Array.from(finalVisited),
                        checkedDomains: scanState.checkedDomains || 0,
                        updatedAt: new Date(),
                    },
                    $setOnInsert: { createdAt: new Date(), startUrl, website }
                },
                { upsert: true }
            );

            events.emit('progress', {
                type: newStatus === 'completed' ? 'done' : 'paused',
                totalPages: finalVisited.size,
                domains: scanState.checkedDomains,
            });
        },
    };
}