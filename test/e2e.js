// End-to-end tests: runs the real actor (src/main.js) against the local Instagram mock. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-instagram.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = (a = 0.0015, b = 0.0025) => JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { 'instagram-item': { eventPriceUsd: a, eventTitle: 'i' }, 'instagram-details': { eventPriceUsd: b, eventTitle: 'd' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);

async function run(name, input, { mock, env = {}, proxy = true, storage } = {}) {
    const dir = storage ?? join(ROOT, 'storage-test', name);
    if (!storage) rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    const proxyConfiguration = proxy ? { useApifyProxy: false, proxyUrls: [mock.proxyUrl] } : { useApifyProxy: false };
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify({ proxyConfiguration, ...input }));
    const t0 = Date.now();
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir,
            CRAWLEE_PURGE_ON_START: '0', IG_BASE: mock.base, DDG_BASE: mock.base, ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true',
            APIFY_ACTOR_PRICING_INFO: PRICING(), APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}', ...env },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, 'run.log'), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const kv = (k) => (existsSync(join(dir, 'key_value_stores', 'default', `${k}.json`)) ? JSON.parse(readFileSync(join(dir, 'key_value_stores', 'default', `${k}.json`), 'utf8')) : null);
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    return { code, rows, ok: rows.filter((r) => r.status === 'ok'), failed: rows.filter((r) => r.status !== 'ok'), charges, chargeCount: charges.reduce((s, c) => s + (c.count ?? 1), 0),
        summary: kv('RUN_SUMMARY'), diag: kv('DIAGNOSTICS'), logs, secs: Math.round((Date.now() - t0) / 100) / 10 };
}

const results = [];
const check = (label, pass, detail = '') => {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const billed = (r) => r.chargeCount === r.ok.length && r.charges.every((c) => c.eventName !== 'apify-default-dataset-item');
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const mock = await startMock({ blockRate: 0.1, alwaysBlocked: ['graphql_timeline'] });

if (want('posts')) {
    console.log('\n=== 1. PROFILE POSTS (GraphQL pagination blocked -> mobile API fallback) ===');
    const r = await run('posts', { directUrls: ['https://www.instagram.com/natgeo/'], resultsType: 'posts', resultsLimit: 30 }, { mock });
    const d = r.diag.methods;
    check('run succeeds with 30 posts', r.code === 0 && r.ok.length === 30, `${r.secs}s`);
    check('no duplicate posts', new Set(r.ok.map((x) => x.id)).size === r.ok.length);
    check('every post billed once as instagram-item, failed rows free', billed(r) && r.charges.every((c) => c.eventName === 'instagram-item'));
    check('fell back to mobile feed after GraphQL kept failing', d['posts:v1_feed_user(mobile)']?.successes >= 1 && !d['posts:graphql_timeline']?.successes, JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, `${v.successes}/${v.attempts}${v.disabled ? ' disabled' : ''}`]))));
    check('engagement rate computed from owner followers', r.ok.filter((x) => x.likesCount !== null).every((x) => typeof x.engagementRate === 'number'));
    check('hashtags and mentions parsed from captions', r.ok.every((x) => x.hashtags.includes('travel') && x.mentions.includes('natgeo')));
    check('carousels have child items, reels have play counts', r.ok.filter((x) => x.type === 'Sidecar').every((x) => x.childPosts.length === 3) && r.ok.filter((x) => x.isReel).every((x) => x.videoPlayCount > 0));
    check('DIAGNOSTICS + RUN_SUMMARY written', Boolean(r.diag && r.summary?.perInput?.[0]?.saved === 30));
}

if (want('details')) {
    console.log('\n=== 2. PROFILE DETAILS (+ profile ID, private, missing, invalid) ===');
    const r = await run('details', { directUrls: ['natgeo', 'https://www.instagram.com/brand_co/', 'https://www.instagram.com/549313808/', 'instagram.com/private_acc', 'ghost_account_x', 'https://facebook.com/nope', '@natgeo'], resultsType: 'details' }, { mock });
    const by = (u) => r.ok.find((x) => x.username === u);
    check('4 profiles saved as instagram-details', r.ok.length === 4 && r.charges.every((c) => c.eventName === 'instagram-details') && billed(r), r.ok.map((x) => x.username).join(','));
    check('profile ID resolved to username', Boolean(by('nasawebb')));
    check('bio contacts with evidence (written-out email, WhatsApp, business email)', ['hello@brandco.com', 'shop@brandco.com'].every((e) => by('brand_co')?.emailsFromBio.concat(by('brand_co').businessEmail).includes(e)) && by('brand_co').phonesFromBio.includes('+447700900123') && by('brand_co').contactEvidence.length >= 3);
    check('engagement and latest posts on profile rows', typeof by('natgeo')?.engagementRate === 'number' && by('natgeo').latestPosts.length === 12);
    check('private profile details still returned', by('private_acc')?.private === true);
    check('missing account -> not_found row, invalid URL -> invalid_input row, @dupe removed', r.failed.some((x) => x.status === 'not_found') && r.failed.some((x) => x.status === 'invalid_input') && r.summary.skipReasons.duplicate_input_url === 1);
}

if (want('post')) {
    console.log('\n=== 3. SINGLE POSTS (shortcode, numeric ID, reel, share link) ===');
    const sc = mock.shortcode('natgeo', 7);
    const r = await run('post', { directUrls: [`https://www.instagram.com/p/${sc}/`, `https://www.instagram.com/p/${mock.mediaId('natgeo', 8)}/`, `https://www.instagram.com/reel/${mock.shortcode('natgeo', 10)}/`, 'https://www.instagram.com/share/BAC6cDeb_-', 'https://www.instagram.com/p/AAAAAAAAAAA/'], resultsType: 'details' }, { mock });
    check('4 posts saved (numeric ID and share link resolved)', r.ok.length === 4 && billed(r), r.ok.map((x) => x.shortCode).join(','));
    check('post fields complete', r.ok.every((x) => x.ownerUsername && x.timestamp && x.displayUrl && x.url));
    check('missing post -> not_found row', r.failed.some((x) => x.status === 'not_found'));
}

if (want('comments')) {
    console.log('\n=== 4. COMMENTS (+ replies) ===');
    const sc = mock.shortcode('natgeo', 7);
    const r = await run('comments', { directUrls: [`https://www.instagram.com/p/${sc}/`, 'https://www.instagram.com/natgeo/'], resultsType: 'comments', resultsLimit: 30, includeNestedComments: true }, { mock });
    const top = r.ok.filter((x) => !x.isReply);
    const replies = r.ok.filter((x) => x.isReply);
    check('30 top-level comments across pages', top.length === 30, `${top.length} top-level`);
    check('replies saved with parentCommentId', replies.length > 0 && replies.every((x) => x.parentCommentId), `${replies.length} replies`);
    check('comments billed as items', billed(r));
    check('comments on a profile -> unsupported_combination row (free)', r.failed.some((x) => x.status === 'unsupported_combination'));
}

if (want('reels')) {
    console.log('\n=== 5. REELS (reels tab, then fallback when the tab is blocked) ===');
    const a = await run('reels', { directUrls: ['https://www.instagram.com/nasawebb/reels/'], resultsType: 'reels', resultsLimit: 10 }, { mock });
    check('10 reels from reels tab, all clips', a.ok.length === 10 && a.ok.every((x) => x.productType === 'clips') && billed(a));
    const m2 = await startMock({ blockRate: 0, alwaysBlocked: ['clips_user', 'graphql_timeline'] });
    const b = await run('reels-fallback', { directUrls: ['nasawebb'], resultsType: 'reels', resultsLimit: 8 }, { mock: m2 });
    m2.close();
    check('reels tab blocked -> reels filtered from profile posts', b.ok.length === 8 && b.ok.every((x) => x.productType === 'clips') && /filtered from profile posts/.test(JSON.stringify(b.summary.perInput)));
}

if (want('mentions')) {
    console.log('\n=== 6. MENTIONS ===');
    const r = await run('mentions', { directUrls: ['natgeo'], resultsType: 'mentions' }, { mock });
    check('tagged posts saved with resultType mention', r.ok.length === 5 && r.ok.every((x) => x.resultType === 'mention' && x.taggedUsers.includes('natgeo')) && billed(r));
}

if (want('hashtag')) {
    console.log('\n=== 7. HASHTAGS ===');
    const d = await run('hashtag-details', { directUrls: ['https://www.instagram.com/explore/tags/travel/', '#nonexistenttag12345'], resultsType: 'details' }, { mock });
    const h = d.ok[0];
    check('hashtag details with post count, measured related tags and posts/day estimate', h?.postsCount === 21310000 && h.relatedHashtags.some((x) => x.hash === '#nature') && h.postsPerDayEstimate > 0, `${h?.relatedHashtags?.slice(0, 3).map((x) => x.hash).join(' ')} · ${h?.postsPerDayBasis}`);
    check('unknown hashtag -> not_found row', d.failed.some((x) => x.status === 'not_found'));
    const p = await run('hashtag-posts', { directUrls: ['#travel'], resultsType: 'posts', resultsLimit: 25 }, { mock });
    check('25 hashtag posts (top + recent + extra pages)', p.ok.length === 25 && billed(p));
}

if (want('place')) {
    console.log('\n=== 8. PLACES ===');
    const d = await run('place', { directUrls: ['https://www.instagram.com/explore/locations/218622660/lucerna-music-bar/'], resultsType: 'details' }, { mock });
    const pl = d.ok[0];
    check('place details: name, category, phone, coordinates, address, business profile', pl?.name === 'Lucerna Music Bar' && pl.lat && pl.phone && pl.address && pl.igBusinessUsername === 'lucernamusicbar' && pl.resultType === 'place');
    const p = await run('place-posts', { directUrls: ['https://www.instagram.com/explore/locations/218622660/'], resultsType: 'posts', resultsLimit: 4 }, { mock });
    check('place posts', p.ok.length === 4 && billed(p));
}

if (want('search')) {
    console.log('\n=== 9. SEARCH (Instagram search login-walled -> DuckDuckGo fallback) ===');
    const r = await run('search', { search: 'vintage', searchType: 'hashtag', searchLimit: 5, resultsType: 'details' }, { mock });
    check('hashtags found via fallback and scraped', r.ok.length === 2 && r.ok.every((x) => x.searchTerm === 'vintage' && x.searchSource === 'duckduckgo'), r.ok.map((x) => x.name).join(','));
    const u = await run('search-users', { search: 'nature photographers', searchType: 'user', searchLimit: 5, resultsType: 'details' }, { mock });
    check('profile search returns profiles only (post links ignored)', u.ok.length === 2 && u.ok.every((x) => x.resultType === 'profile'));
}

if (want('filters')) {
    console.log('\n=== 10. FILTERS — with vs without ===');
    const base = { directUrls: ['natgeo'], resultsType: 'posts', resultsLimit: 60 };
    const all = await run('f-all', base, { mock });
    const recent = await run('f-date', { ...base, onlyPostsNewerThan: '20 days' }, { mock });
    const cutoff = Date.now() - 20 * 864e5;
    check('date filter: only posts newer than 20 days, stopped paging early', recent.ok.length < all.ok.length && recent.ok.every((x) => Date.parse(x.timestamp) >= cutoff) && recent.summary.requests.requests < all.summary.requests.requests,
        `${recent.ok.length} of ${all.ok.length}, requests ${recent.summary.requests.requests} vs ${all.summary.requests.requests}`);
    const pin = await run('f-pinned', { ...base, resultsLimit: 12, skipPinnedPosts: true }, { mock });
    check('skip pinned posts', pin.ok.every((x) => !x.isPinned) && all.ok.some((x) => x.isPinned));
    const likes = await run('f-likes', { ...base, minLikes: 1500000 }, { mock });
    check('min likes: every kept post meets it, fewer than unfiltered', likes.ok.length < all.ok.length && likes.ok.every((x) => x.likesCount >= 1500000), `${likes.ok.length} kept`);
    check('filtered posts never charged', billed(recent) && billed(likes) && billed(pin));
}

if (want('limits')) {
    console.log('\n=== 11. MAX COST, MAX ITEMS, TIMEOUT, SKIP PREVIOUS, ALL BLOCKED ===');
    const mc = await run('maxcost', { directUrls: ['natgeo'], resultsLimit: 60 }, { mock, env: { ACTOR_MAX_TOTAL_CHARGE_USD: '7', APIFY_ACTOR_PRICING_INFO: PRICING(1, 1) } });
    check('max cost: stops at exactly the budget (7 events at $1 locally)', mc.code === 0 && mc.summary.stopReason === 'max_cost_per_run_reached' && mc.chargeCount === 7 && mc.ok.length === 7);
    const mi = await run('maxitems', { directUrls: ['natgeo', 'nasawebb'], resultsLimit: 50, maxItems: 13 }, { mock });
    check('max items: exactly 13 across inputs', mi.ok.length === 13 && mi.chargeCount === 13);
    const slow = await startMock({ blockRate: 0, delayMs: 3000 });
    const to = await run('timeout', { directUrls: ['natgeo', 'nasawebb', 'brand_co'], resultsLimit: 60 }, { mock: slow, env: { ACTOR_TIMEOUT_AT: new Date(Date.now() + 56000).toISOString() } });
    slow.close();
    check('timeout: stops ~45 s early, SUCCEEDED, data saved', to.code === 0 && /timeout_approaching/.test(to.summary.stopReason) && to.ok.length > 0 && to.secs < 20, `${to.secs}s, ${to.ok.length} saved`);
    const storage = join(ROOT, 'storage-test', 'dedupe');
    rmSync(storage, { recursive: true, force: true });
    const inp = { directUrls: ['brand_co'], resultsLimit: 10, skipPreviouslyScraped: true, dedupeStoreName: 'test-seen' };
    const first = await run('dedupe1', inp, { mock, storage });
    const firstIds = new Set(first.ok.map((x) => x.id));
    const second = await run('dedupe2', { ...inp, resultsLimit: 15 }, { mock, storage });
    const newRows = second.ok.filter((x) => !firstIds.has(x.id) || second.ok.indexOf(x) >= first.ok.length);
    check('skip previous runs: second run skips the 10 seen posts and saves 15 new ones, no overlap',
        second.summary.skipReasons.seen_in_previous_run === 10 && second.summary.saved === 15 && newRows.length === 15, JSON.stringify(second.summary.skipReasons));
    const down = await startMock({ blockRate: 1 });
    const b = await run('blocked', { directUrls: ['natgeo', 'brand_co'], resultsType: 'details' }, { mock: down, proxy: false });
    down.close();
    check('all blocked without proxy: blocked rows tell the user to use RESIDENTIAL, nothing charged', b.code === 0 && b.failed.length === 2 && b.failed.every((x) => x.status === 'blocked' && /RESIDENTIAL/.test(x.fixHint)) && b.chargeCount === 0, `${b.secs}s`);
}

mock.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed.`);
process.exit(results.every(Boolean) ? 0 : 1);
