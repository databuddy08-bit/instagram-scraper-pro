// HTTP client: proxy sessions, rate limiting, block detection, fallback strategy chains and per-endpoint diagnostics.
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import { Actor, log } from 'apify';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const IG_APP_ID = '936619743392459';
const LSD = 'AVqbxe3J_YA';
const MOBILE_UA = 'Instagram 337.0.0.0.77 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 609412000)';
const IOS_UA = 'Instagram 361.0.0.35.82 (iPhone15,3; iOS 18_1; en_US; en; scale=3.00; 1290x2796; 673486213) AppleWebKit/420+';
const IOS_APP_ID = '124024574287414';

// Tests point every Instagram host at a local mock server.
const TEST_BASE = process.env.IG_BASE ?? null;
export const WWW = TEST_BASE ?? 'https://www.instagram.com';
export const API = process.env.IG_API_BASE ?? TEST_BASE ?? 'https://i.instagram.com';
export const DDG = process.env.DDG_BASE ?? 'https://html.duckduckgo.com';

export class NotFoundError extends Error {}
export class BlockedError extends Error {}
/** Instagram answered "login required" for this method (a wall, not a rate limit) — retrying on many IPs is wasted money. */
export class LoginWallError extends BlockedError {}
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
        this.jar = new CookieJar(); // a fresh IP gets fresh cookies, like a new visitor
        this.lsd = null;
        this.warmed = false;
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
        return (this.methods[name] ??= { attempts: 0, successes: 0, blocked: 0, loginWall: 0, notFound: 0, shapeErrors: 0, networkErrors: 0, statuses: {}, lastProblem: null, disabled: false });
    }

    record(name, kind, status, problem, routeMayBeAtFault = false) {
        const m = this.get(name);
        m.attempts += 1;
        if (routeMayBeAtFault) m.routeBlocked = (m.routeBlocked ?? 0) + 1;
        if (status) m.statuses[status] = (m.statuses[status] ?? 0) + 1;
        if (kind === 'blocked') m.blocked += 1;
        else if (kind === 'loginwall') m.loginWall += 1;
        else if (kind === 'notfound') m.notFound += 1;
        else if (kind === 'shape') m.shapeErrors += 1;
        else if (kind === 'network') m.networkErrors += 1;
        if (problem) m.lastProblem = String(problem).slice(0, 200);
        if (!m.disabled && m.successes === 0 && (m.attempts - m.notFound - (m.routeBlocked ?? 0) >= this.disableAfter || m.loginWall >= 2)) {
            m.disabled = true;
            log.warning(`Method "${name}" ${m.loginWall >= 2 ? 'is behind Instagram\'s login wall' : `failed ${m.attempts} times`} — skipping it for the rest of this run (last: ${m.lastProblem}).`);
        }
    }

    /** True when every method starting with `prefix` has been tried and none ever worked in this run. */
    hopeless(prefix) {
        const ms = Object.entries(this.methods).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
        return ms.length > 0 && ms.every((m) => m.successes === 0 && (m.disabled || m.loginWall + m.blocked >= 3));
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
    /**
     * @param routes ordered network routes [{label, proxy}] (proxy undefined = the server's own IP).
     *   When Instagram keeps blocking a route, the client switches to the next one for the rest of the run.
     */
    constructor({ routes, msLeft, stats, saveRaw }) {
        this.routes = routes.map((r) => ({ ...r, ok: 0, fail: 0, streak: 0, limiter: new RateLimiter(r.proxy ? 400 : 40) }));
        this.routeIdx = 0;
        this.limiter = { wait: () => this.route.limiter.wait() };
        this.msLeft = msLeft;
        this.stats = stats;
        this.diag = new Diagnostics({ saveRaw, useProxy: true });
    }

    shouldStop() {
        return this.msLeft() <= 0;
    }

    get route() {
        return this.routes[this.routeIdx];
    }

    get useProxy() {
        return Boolean(this.route.proxy);
    }

    /** Route health: switch to the next route when this one keeps getting blocked and has never (or no longer) worked. */
    routeResult(idx, ok) {
        const r = this.routes[idx];
        if (!r) return;
        if (ok) {
            r.ok += 1;
            r.streak = 0;
            return;
        }
        r.fail += 1;
        r.streak += 1;
        const dead = (r.ok === 0 && r.fail >= 5) || r.streak >= 10;
        if (dead && idx === this.routeIdx && this.routeIdx < this.routes.length - 1) {
            this.routeIdx += 1;
            this.stats.routeSwitches = (this.stats.routeSwitches ?? 0) + 1;
            log.warning(`Instagram keeps blocking "${r.label}" (${r.ok} ok / ${r.fail} blocked). Switching to "${this.route.label}".`);
        }
    }

    routesSummary() {
        return this.routes.map((r, i) => ({ route: r.label, used: i <= this.routeIdx, ok: r.ok, blocked: r.fail, active: i === this.routeIdx }));
    }

    async retryDelay(attempt) {
        const ms = this.useProxy ? 800 + Math.random() * 400 : Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000;
        await sleep(Math.min(ms, this.msLeft() - 1000));
    }

    /**
     * One HTTP request, classified. Never throws for HTTP problems.
     * @returns {Promise<{kind:'ok'|'blocked'|'notfound'|'redirect'|'error'|'network', status:number, json:any, body:string, url:string, location?:string, problem?:string}>}
     */
    /** Loads instagram.com once per session (per IP) like a real visitor: cookies + the page's LSD token for GraphQL calls. */
    async warm(session) {
        if (session.warmed) return;
        session.warmed = true;
        const r = await this.request({ url: `${WWW}/`, style: 'html', expect: 'html', session, name: 'warmup_homepage' });
        session.lsd = r.body?.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? r.body?.match(/"lsd":"([^"]+)"/)?.[1] ?? null;
        this.stats.warmups = (this.stats.warmups ?? 0) + 1;
    }

    async request({ method = 'GET', url, form, style = 'web', session, referer, expect = 'json', name }) {
        const routeIdx = this.routeIdx;
        const route = this.routes[routeIdx];
        await route.limiter.wait();
        this.stats.requests += 1;
        const headers = {};
        const opts = {};
        if (style === 'mobile' || style === 'ios') {
            opts.useHeaderGenerator = false;
            Object.assign(headers, style === 'ios'
                ? { 'user-agent': IOS_UA, 'x-ig-app-id': IOS_APP_ID, accept: '*/*', 'accept-language': 'en-US' }
                : { 'user-agent': MOBILE_UA, 'x-ig-app-id': IG_APP_ID, accept: '*/*', 'accept-language': 'en-US', 'x-ig-capabilities': '3brTvw==' });
        } else if (style === 'web') {
            Object.assign(headers, {
                'x-ig-app-id': IG_APP_ID, 'x-asbd-id': '129477', 'x-ig-www-claim': '0', 'x-requested-with': 'XMLHttpRequest',
                'x-fb-lsd': session?.lsd ?? LSD, accept: '*/*', referer: referer ?? 'https://www.instagram.com/',
            });
            const csrf = session?.jar?.getCookiesSync('https://www.instagram.com').find((c) => c.key === 'csrftoken')?.value;
            if (csrf) headers['x-csrftoken'] = csrf;
            opts.headerGeneratorOptions = { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'], operatingSystems: ['windows', 'macos'] };
        } else {
            opts.headerGeneratorOptions = { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'], operatingSystems: ['windows', 'macos'] };
            headers.accept = 'text/html,application/xhtml+xml';
        }
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            if (style === 'web') form = { lsd: session?.lsd ?? LSD, ...form };
        }
        let res;
        try {
            res = await gotScraping({
                url,
                method,
                ...(form ? { body: new URLSearchParams(form).toString() } : {}),
                headers,
                ...opts,
                proxyUrl: route.proxy ? await route.proxy.newUrl(session.id) : undefined,
                ...(!['mobile', 'ios'].includes(style) && session?.jar ? { cookieJar: session.jar } : {}),
                followRedirect: false,
                throwHttpErrors: false,
                retry: { limit: 0 },
                timeout: { request: 25000 },
            });
        } catch (err) {
            this.stats.networkErrors += 1;
            this.routeResult(routeIdx, false);
            return { kind: 'network', status: 0, json: null, body: '', url, problem: `network error ${err.code || err.message}` };
        }
        const status = res.statusCode;
        const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
        const out = this.classify(res, status, body, expect, url);
        if (out.kind === 'ok' || out.kind === 'notfound' || out.kind === 'loginwall') this.routeResult(routeIdx, true);
        else if (out.kind === 'blocked') this.routeResult(routeIdx, false);
        if (name) await this.diag.raw(name, url, status, body);
        return out;
    }

    classify(res, status, body, expect, url) {
        let json = null;
        if (expect === 'json' || body.trimStart().startsWith('{')) {
            try {
                json = JSON.parse(body.replace(/^for \(;;\);/, ''));
            } catch { /* not JSON */ }
        }
        const location = res.headers?.location;
        const msg = json?.message ? `"${String(json.message).slice(0, 90)}"` : '';
        if (status >= 300 && status < 400) {
            if (LOGIN_RE.test(location ?? '')) return { kind: 'loginwall', status, json, body, url, location, problem: `HTTP ${status} redirect to login page` };
            return { kind: 'redirect', status, json, body, url, location, problem: `HTTP ${status} redirect` };
        }
        if (status === 404) return { kind: 'notfound', status, json, body, url, problem: 'HTTP 404' };
        if (/login_required|checkpoint_required/i.test(json?.message ?? '') || (status === 403 && /not-logged-in/.test(body.slice(0, 400)) && expect === 'json')) {
            return { kind: 'loginwall', status, json, body, url, problem: `HTTP ${status} login required` };
        }
        if ([401, 403, 429, 999].includes(status) || json?.require_login || json?.spam || /challenge_required/i.test(json?.message ?? '')) {
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
            const attempts = Number(process.env.IG_MAX_ATTEMPTS) || m.attempts || (this.useProxy ? 4 : 2); // IG_MAX_ATTEMPTS: local debugging only
            let restarts = 0;
            for (let a = 0; a < attempts; a++) {
                if (this.shouldStop()) throw new StoppedError('run stopping');
                const routeAtStart = this.routeIdx;
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
                    if (err instanceof LoginWallError) {
                        this.diag.record(m.name, 'loginwall', err.status, err.message);
                        problems.push(`${m.name}: ${err.message}`);
                        // a login wall isn't an IP problem: keep the session (and its warm-up) instead of paying for a new one
                        // One retry on a new IP the first time a wall is seen in this run; after that, go straight to the next method.
                        if (a >= 1 || this.diag.get(m.name).loginWall > 1 || this.diag.get(m.name).disabled) break;
                        continue;
                    }
                    if (err instanceof BlockedError) {
                        this.diag.record(m.name, err.network ? 'network' : 'blocked', err.status, err.message, this.routeIdx < this.routes.length - 1);
                        problems.push(`${m.name}: ${err.message}`);
                        session.rotate();
                        // The route just switched (the old one is dead): give this method a fresh budget on the new route.
                        if (this.routeIdx !== routeAtStart && restarts < this.routes.length) {
                            restarts += 1;
                            a = -1;
                            continue;
                        }
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
        const walled = problems.length && problems.every((p) => /login (required|page)|login wall|skipped/.test(p));
        const err = walled ? new LoginWallError(`Instagram requires a login for this (${summary})`) : new BlockedError(`every method failed (${summary})`);
        throw err;
    }
}

/** Turns a classified response into data or the right error. */
export function check(res) {
    if (res.kind === 'ok') return res;
    if (res.kind === 'notfound') throw new NotFoundError(res.problem);
    if (res.kind === 'loginwall') {
        const e = new LoginWallError(res.problem);
        e.status = res.status;
        throw e;
    }
    if (res.kind === 'blocked' || res.kind === 'network' || (res.kind === 'error' && !res.fatal)) {
        const e = new BlockedError(res.problem);
        e.status = res.status;
        e.network = res.kind === 'network';
        throw e;
    }
    throw new ShapeError(res.problem ?? `unexpected ${res.kind}`);
}
