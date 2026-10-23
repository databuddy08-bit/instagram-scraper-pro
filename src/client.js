// HTTP client: proxy sessions, rate limiting, block detection, fallback strategy chains and per-endpoint diagnostics.
import { gotScraping } from 'got-scraping';
import { Actor, log } from 'apify';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const IG_APP_ID = '936619743392459';
const LSD = 'AVqbxe3J_YA';
const MOBILE_UA = 'Instagram 337.0.0.0.77 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 609412000)';

// Tests point every Instagram host at a local mock server.
const TEST_BASE = process.env.IG_BASE ?? null;
export const WWW = TEST_BASE ?? 'https://www.instagram.com';
export const API = TEST_BASE ?? 'https://i.instagram.com';
export const DDG = process.env.DDG_BASE ?? 'https://html.duckduckgo.com';

export class NotFoundError extends Error {}
export class BlockedError extends Error {}
export class StoppedError extends Error {}
/** The endpoint answered but not in a shape we understand (changed or retired) — try the next method, don't retry. */
export class ShapeError extends Error {}

class RateLimiter {
    constructor(perMinute) {
        this.interval = 60000 / perMinute;
        this.next = 0;
    }

    async wait() {
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.interval;
        if (slot > now) await sleep(slot - now);
    }
}

export class Session {
    constructor() {
        this.rotate();
    }

    rotate() {
        this.id = `s${Math.random().toString(36).slice(2, 12)}`;
        this.uses = 0;
    }

    used() {
        this.uses += 1;
        if (this.uses >= 20) this.rotate();
    }
}

/** Per-method statistics written to the DIAGNOSTICS record so the first live run shows exactly what works. */
export class Diagnostics {
    constructor({ saveRaw, useProxy }) {
        this.methods = {};
        this.saveRaw = saveRaw;
        this.rawSaved = {};
        this.disableAfter = useProxy ? 12 : 6;
    }

    get(name) {
        return (this.methods[name] ??= { attempts: 0, successes: 0, blocked: 0, notFound: 0, shapeErrors: 0, networkErrors: 0, statuses: {}, lastProblem: null, disabled: false });
    }

    record(name, kind, status, problem) {
        const m = this.get(name);
        m.attempts += 1;
        if (status) m.statuses[status] = (m.statuses[status] ?? 0) + 1;
        if (kind === 'blocked') m.blocked += 1;
        else if (kind === 'notfound') m.notFound += 1;
        else if (kind === 'shape') m.shapeErrors += 1;
        else if (kind === 'network') m.networkErrors += 1;
        if (problem) m.lastProblem = String(problem).slice(0, 200);
        if (!m.disabled && m.successes === 0 && m.attempts - m.notFound >= this.disableAfter) {
            m.disabled = true;
            log.warning(`Method "${name}" failed ${m.attempts} times with no success — skipping it for the rest of this run (last: ${m.lastProblem}).`);
        }
    }

    success(name) {
        this.get(name).successes += 1;
    }

    async raw(name, url, status, body) {
        if (!this.saveRaw) return;
        const n = (this.rawSaved[name] ?? 0) + 1;
        if (n > 2) return;
        this.rawSaved[name] = n;
        const key = `RAW_${name}_${n}`.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 250);
        await Actor.setValue(key, { url, status, body: String(body ?? '').slice(0, 900000) }).catch(() => {});
    }

    toJSON() {
        return Object.fromEntries(Object.entries(this.methods).sort((a, b) => b[1].attempts - a[1].attempts).map(([k, v]) => [k, {
            ...v, successRatePct: v.attempts ? Math.round((v.successes / v.attempts) * 1000) / 10 : null,
        }]));
    }
}

const LOGIN_RE = /\/accounts\/login|\/challenge\/|\/accounts\/suspended/i;

export class Client {
    constructor({ proxyConfiguration, msLeft, stats, saveRaw }) {
        this.proxy = proxyConfiguration;
        this.useProxy = Boolean(proxyConfiguration);
        this.limiter = new RateLimiter(this.useProxy ? 400 : 60);
        this.msLeft = msLeft;
        this.stats = stats;
        this.diag = new Diagnostics({ saveRaw, useProxy: this.useProxy });
    }

    shouldStop() {
        return this.msLeft() <= 0;
    }

    async retryDelay(attempt) {
        const ms = this.useProxy ? 800 + Math.random() * 400 : Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000;
        await sleep(Math.min(ms, this.msLeft() - 1000));
    }

    /**
     * One HTTP request, classified. Never throws for HTTP problems.
     * @returns {Promise<{kind:'ok'|'blocked'|'notfound'|'redirect'|'error'|'network', status:number, json:any, body:string, url:string, location?:string, problem?:string}>}
     */
    async request({ method = 'GET', url, form, style = 'web', session, referer, expect = 'json', name }) {
        await this.limiter.wait();
        this.stats.requests += 1;
        const headers = {};
        const opts = {};
        if (style === 'mobile') {
            opts.useHeaderGenerator = false;
            Object.assign(headers, { 'user-agent': MOBILE_UA, 'x-ig-app-id': IG_APP_ID, accept: '*/*', 'accept-language': 'en-US', 'x-ig-capabilities': '3brTvw==' });
        } else if (style === 'web') {
            Object.assign(headers, {
                'x-ig-app-id': IG_APP_ID, 'x-asbd-id': '129477', 'x-ig-www-claim': '0', 'x-requested-with': 'XMLHttpRequest',
                'x-fb-lsd': LSD, accept: '*/*', referer: referer ?? 'https://www.instagram.com/',
            });
            opts.headerGeneratorOptions = { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'], operatingSystems: ['windows', 'macos'] };
        } else {
            opts.headerGeneratorOptions = { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'], operatingSystems: ['windows', 'macos'] };
            headers.accept = 'text/html,application/xhtml+xml';
        }
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            if (style === 'web') form = { lsd: LSD, ...form };
        }
        let res;
        try {
            res = await gotScraping({
                url,
                method,
                ...(form ? { body: new URLSearchParams(form).toString() } : {}),
                headers,
                ...opts,
                proxyUrl: this.proxy ? await this.proxy.newUrl(session.id) : undefined,
                followRedirect: false,
                throwHttpErrors: false,
                retry: { limit: 0 },
                timeout: { request: 25000 },
            });
        } catch (err) {
            this.stats.networkErrors += 1;
            return { kind: 'network', status: 0, json: null, body: '', url, problem: `network error ${err.code || err.message}` };
        }
        const status = res.statusCode;
        const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
        let json = null;
        if (expect === 'json' || body.trimStart().startsWith('{')) {
            try {
                json = JSON.parse(body.replace(/^for \(;;\);/, ''));
            } catch { /* not JSON */ }
        }
        if (name) await this.diag.raw(name, url, status, body);
        const location = res.headers?.location;
        const msg = json?.message ? `"${String(json.message).slice(0, 90)}"` : '';
        if (status >= 300 && status < 400) {
            if (LOGIN_RE.test(location ?? '')) return { kind: 'blocked', status, json, body, url, location, problem: `HTTP ${status} redirect to login` };
            return { kind: 'redirect', status, json, body, url, location, problem: `HTTP ${status} redirect` };
        }
        if (status === 404) return { kind: 'notfound', status, json, body, url, problem: 'HTTP 404' };
        if ([401, 403, 429, 999].includes(status) || json?.require_login || json?.spam || /checkpoint_required|login_required|challenge_required/i.test(json?.message ?? '')) {
            return { kind: 'blocked', status, json, body, url, problem: `HTTP ${status} ${msg}`.trim() };
        }
        if (status >= 500) return { kind: 'error', status, json, body, url, problem: `HTTP ${status}` };
        if (status >= 400) return { kind: 'error', status, json, body, url, problem: `HTTP ${status} ${msg}`.trim(), fatal: true };
        if (expect === 'json' && !json) {
            if (/<form[^>]+login|"loginPage"|\/accounts\/login\//i.test(body.slice(0, 50000))) return { kind: 'blocked', status, json, body, url, problem: 'login page instead of data' };
            return { kind: 'error', status, json, body, url, problem: 'response was not JSON', fatal: true };
        }
        return { kind: 'ok', status, json, body, url };
    }

    /**
     * Runs fallback methods in order until one returns data.
     * Each method: { name, fn: async (session) => data | null, notFoundIsFinal?: boolean, attempts?: number }
     * fn throws BlockedError (retry on new IP), NotFoundError, ShapeError (go to next method).
     */
    async run(methods, session) {
        const problems = [];
        for (const m of methods) {
            const d = this.diag.get(m.name);
            if (d.disabled) {
                problems.push(`${m.name}: skipped (kept failing earlier in this run)`);
                continue;
            }
            const attempts = m.attempts ?? (this.useProxy ? 4 : 2);
            for (let a = 0; a < attempts; a++) {
                if (this.shouldStop()) throw new StoppedError('run stopping');
                let data;
                try {
                    data = await m.fn(session);
                } catch (err) {
                    if (err instanceof NotFoundError) {
                        this.diag.record(m.name, 'notfound', null, err.message);
                        if (m.notFoundIsFinal) throw err;
                        problems.push(`${m.name}: ${err.message}`);
                        break;
                    }
                    if (err instanceof ShapeError) {
                        this.diag.record(m.name, 'shape', null, err.message);
                        problems.push(`${m.name}: ${err.message}`);
                        break;
                    }
                    if (err instanceof BlockedError) {
                        this.diag.record(m.name, err.network ? 'network' : 'blocked', err.status, err.message);
                        problems.push(`${m.name}: ${err.message}`);
                        session.rotate();
                        if (this.diag.get(m.name).disabled) break;
                        if (a < attempts - 1) await this.retryDelay(a);
                        continue;
                    }
                    throw err;
                }
                if (data === null || data === undefined) {
                    this.diag.record(m.name, 'shape', null, 'empty result');
                    problems.push(`${m.name}: empty result`);
                    break;
                }
                this.diag.record(m.name, 'ok', 200, null);
                this.diag.success(m.name);
                session.used();
                return { data, method: m.name };
            }
        }
        const counts = {};
        for (const p of problems) counts[p] = (counts[p] ?? 0) + 1;
        const summary = Object.entries(counts).slice(-6).map(([p, n]) => (n > 1 ? `${n}× ${p}` : p)).join('; ');
        throw new BlockedError(`every method failed (${summary})`);
    }
}

/** Turns a classified response into data or the right error. */
export function check(res) {
    if (res.kind === 'ok') return res;
    if (res.kind === 'notfound') throw new NotFoundError(res.problem);
    if (res.kind === 'blocked' || res.kind === 'network' || (res.kind === 'error' && !res.fatal)) {
        const e = new BlockedError(res.problem);
        e.status = res.status;
        e.network = res.kind === 'network';
        throw e;
    }
    throw new ShapeError(res.problem ?? `unexpected ${res.kind}`);
}
