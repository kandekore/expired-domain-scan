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

async function getWhoisData(domain) {
    const { WHMCS_API_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET } = process.env;

    if (!WHMCS_API_URL || !WHMCS_API_IDENTIFIER || !WHMCS_API_SECRET) {
        return { expiryDate: null, reason: "WHMCS credentials missing" };
    }

    const postData = {
        identifier: WHMCS_API_IDENTIFIER,
        secret: WHMCS_API_SECRET,
        action: 'DomainWhois',
        domain: domain,
        responsetype: 'json',
    };

    try {
        const response = await got.post(WHMCS_API_URL, { form: postData }).json();

        if (response.result === 'error') {
            return { expiryDate: null, reason: response.message || "API Error" };
        }
        if (response.status === 'available') {
            return { expiryDate: null, reason: "Available for registration" };
        }
        if (response.whois) {
            const expiryMatch = response.whois.match(/Registry Expiry Date:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/i);
            if (expiryMatch && expiryMatch[1]) {
                const dateStr = expiryMatch[1].trim();
                const date = new Date(dateStr);
                if (!isNaN(date)) {
                    return { expiryDate: date.toISOString().split('T')[0], reason: null };
                }
            }
            return { expiryDate: null, reason: "WHOIS lookup not supported for this TLD" };
        }
    } catch (error) {
        console.error(`WHMCS API call failed for ${domain}:`, error.message);
        return { expiryDate: null, reason: "API call failed" };
    }
    return { expiryDate: null, reason: "Unknown reason" };
}

async function dnsHasAddresses(domain) {
  try {
    const addrs = await dns.lookup(domain, { all: true, verbatim: false });
    if (Array.isArray(addrs) && addrs.length > 0) return { hasDns: true, nxDomain: false };
  } catch (e) {}
  // ... other DNS checks
  return { hasDns: false, nxDomain: false };
}

async function checkDomain(domain, events, resultsCollection, website) {
    const asciiDomain = domain.includes('xn--') ? domain : punycode.toASCII(domain);
    const dnsResult = await dnsHasAddresses(asciiDomain);
  
    let result;
    if (!dnsResult.hasDns && dnsResult.nxDomain) {
      result = { status: 'no-dns', code: 'NXDOMAIN' };
    } else {
      result = { status: 'ok' };
    }
  
    if (resultsCollection && result.status === 'no-dns') {
        const tld = asciiDomain.split('.').pop();
        const whois = await getWhoisData(asciiDomain);
        const doc = {
            website,
            domain: asciiDomain,
            tld,
            status: result.status,
            code: result.code,
            expiryDate: whois.expiryDate,
            expiryDateReason: whois.reason,
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
    isAggressive = true, // Receive the flag
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
            events.emit('progress', {
                type: 'stats',
                visited: totalVisited,
                inQueue: queue.size + scanState.queue.size,
                checkedDomains: scanState.checkedDomains || 0,
                crawlRate,
            });
        }, 1000);
    }

    async function crawl(url, scanState) {
        if (visitedThisBatch.size >= batchSize || scanState.visited.has(url) || visitedThisBatch.has(url)) return;
        visitedThisBatch.add(url);
        events.emit('progress', { type: 'page', stage: 'enqueue', url, visited: (scanState.visited?.size || 0) + visitedThisBatch.size });
        try {
            if (!(await robots.canCrawl(url, 'ExpiredBot'))) return;

            // --- Use the flag to set the delay ---
            const delay = isAggressive ? 250 : 1500;
            await sleep(delay);

            const res = await got(url, { timeout: { request: 10000 }, followRedirect: true });
            const $ = cheerio.load(res.body);
            for (const el of $('a[href]')) {
                const href = $(el).attr('href');
                const abs = normalizeUrl(url, href);
                if (!abs) continue;
                const u = new URL(abs);
                if (u.origin === origin) {
                    if (!scanState.visited.has(abs) && !visitedThisBatch.has(abs)) {
                        scanState.queue.add(abs);
                    }
                } else {
                    const domain = u.hostname;
                    if (!foundOutbound.has(domain)) {
                        foundOutbound.set(domain, true);
                        queue.add(async () => {
                            const result = await checkDomain(domain, events, resultsCollection, website);
                            scanState.checkedDomains = (scanState.checkedDomains || 0) + 1;
                            events.emit('progress', { type: 'domain', stage: 'check-done', domain, result });
                        });
                    }
                }
            }
        } catch (err) {
            events.emit('progress', { type: 'page', stage: 'fetch-error', url, error: err.message });
        }
    }

    return {
        async start() {
            let scanStateDoc = await scansCollection.findOne({ website });
            if (mode === 'new' || !scanStateDoc) {
                if(scanStateDoc) await scansCollection.deleteOne({ website });
                scanStateDoc = { website, startUrl, status: 'running', queue: [startUrl], visited: [], checkedDomains: 0, createdAt: new Date() };
            } else {
                scanStateDoc.status = 'running';
            }
            const scanState = { ...scanStateDoc, queue: new Set(scanStateDoc.queue), visited: new Set(scanStateDoc.visited) };
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
            await scansCollection.updateOne({ website }, {
                $set: { status: newStatus, queue: Array.from(finalQueue), visited: Array.from(finalVisited), checkedDomains: scanState.checkedDomains || 0, updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date(), startUrl, website }
            }, { upsert: true });
            events.emit('progress', { type: newStatus === 'completed' ? 'done' : 'paused', totalPages: finalVisited.size, domains: scanState.checkedDomains });
        },
    };
}