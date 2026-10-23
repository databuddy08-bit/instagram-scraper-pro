// Instagram Scraper Pro — Apify actor entry point.
import { Actor, log } from 'apify';
import { Client, Session, NotFoundError, BlockedError, StoppedError, LoginWallError } from './client.js';
import { makeEndpoints, normalizePost } from './endpoints.js';
import { profileFromUser, commentFromGraph, commentFromV1, relatedFromPosts, postsPerDayFromPosts, postFromGraph } from './parse.js';
import { parseTarget, parseNewerThan } from './urls.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_ITEM = 'instagram-item'; // posts, reels, comments, mentions
export const EVENT_DETAILS = 'instagram-details'; // profile, hashtag and place details

const CONCURRENCY = 25;
const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 50;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
const TYPES = ['posts', 'reels', 'comments', 'mentions', 'details'];
const opts = {
    directUrls: (Array.isArray(input.directUrls) ? input.directUrls : []).map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean),
    resultsType: TYPES.includes(input.resultsType) ? input.resultsType : 'posts',
    resultsLimit: num(input.resultsLimit, 50, 1, 100000),
    search: String(input.search ?? '').split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean),
    searchType: ['user', 'hashtag', 'place'].includes(input.searchType) ? input.searchType : 'hashtag',
    searchLimit: num(input.searchLimit, 10, 1, 250),
    skipPinnedPosts: Boolean(input.skipPinnedPosts),
    isNewestComments: Boolean(input.isNewestComments),
    includeNestedComments: Boolean(input.includeNestedComments),
    addParentData: Boolean(input.addParentData),
    maxItems: num(input.maxItems, 0, 0, 1e9),
    minLikes: num(input.minLikes, 0, 0, 1e12),
    minComments: num(input.minComments, 0, 0, 1e12),
    includeFailedInputs: input.includeFailedInputs !== false,
    skipPreviouslyScraped: Boolean(input.skipPreviouslyScraped),
    dedupeStoreName: /^[a-z0-9-]{1,63}$/.test(input.dedupeStoreName ?? '') ? input.dedupeStoreName : 'instagram-scraper-pro-seen',
    saveRawResponses: Boolean(input.saveRawResponses),
};
let newerThan = null;
try {
    newerThan = parseNewerThan(input.onlyPostsNewerThan);
} catch (err) {
    await Actor.fail(err.message);
}

// ---------- Deadline, proxy, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
} catch (err) {
    log.warning(`Proxy could not be configured (${err.message}). Continuing without a proxy — Instagram will block most requests.`);
}
const groups = input.proxyConfiguration?.apifyProxyGroups ?? [];
const proxyLabel = !proxyConfiguration ? 'no proxy' : input.proxyConfiguration?.useApifyProxy ? `Apify proxy (${groups.length ? groups.join(', ') : 'datacenter'})` : 'custom proxy';
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
log.info(`Mode: ${opts.resultsType} · proxy: ${proxyLabel} · ${proxyConfiguration ? 400 : 60} req/min · pricing: ${pricing.isPayPerEvent ? 'pay per event' : 'not PPE'} · max cost: ${Number.isFinite(pricing.maxTotalChargeUsd) ? `$${pricing.maxTotalChargeUsd}` : 'none'}`);


const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null, resultsType: opts.resultsType, proxy: proxyLabel,
    inputs: 0, saved: 0, savedByType: {}, failedRowsSaved: 0, chargedEvents: { [EVENT_ITEM]: 0, [EVENT_DETAILS]: 0 },
    statusCounts: {}, skipReasons: {}, perInput: [], requests: { requests: 0, networkErrors: 0 }, methodsThatWorked: [], methodsThatFailed: [],
};
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
// Network routes, tried in order: the user's proxy, then (if fallback is on) Apify datacenter proxy, then the server's own IP.
// Instagram rate-limits some IP pools far more than others; the client moves to the next route when one keeps getting blocked.
const routes = [{ label: proxyConfiguration ? proxyLabel : 'no proxy (server IP)', proxy: proxyConfiguration }]; // the user's choice always comes first
if (input.proxyFallback !== false) {
    const isDatacenter = input.proxyConfiguration?.useApifyProxy && !groups.length;
    const apifyProxyUsable = Actor.isAtHome() || Boolean(process.env.APIFY_PROXY_PASSWORD);
    if (!isDatacenter && apifyProxyUsable) {
        try {
            const dc = await Actor.createProxyConfiguration({ useApifyProxy: true });
            if (dc) routes.push({ label: 'Apify proxy (datacenter)', proxy: dc });
        } catch { /* datacenter proxy not available on this account */ }
    }
    if (proxyConfiguration) routes.push({ label: 'no proxy (server IP)', proxy: undefined });
}
log.info(`Network routes: ${routes.map((r) => r.label).join(' → ')}`);
const client = new Client({ routes, msLeft, stats: summary.requests, saveRaw: opts.saveRawResponses });
const ep = makeEndpoints(client);

let seenStore = null;
let seenPrev = new Set();
if (opts.skipPreviouslyScraped) {
    seenStore = await Actor.openKeyValueStore(opts.dedupeStoreName);
    seenPrev = new Set((await seenStore.getValue('SEEN_IDS')) ?? []);
    log.info(`Skip previous runs: ${seenPrev.size} items remembered in "${opts.dedupeStoreName}".`);
}
const seenRun = new Set();

// ---------- Output ----------
let chain = Promise.resolve();
const FIX = {
    invalid_input: 'Use a profile, post, reel, hashtag or place URL (or a @username / #hashtag).',
    unsupported_combination: null,
    not_found: 'Instagram says this does not exist, was renamed or deleted, or is restricted (age/region). Open the URL in a private browser window to check.',
    private: 'This account is private — only public data can be scraped.',
    blocked: null,
    no_results: null,
    error: 'Unexpected error. Run again; if it repeats, send the run log and the DIAGNOSTICS record to the developer.',
};
const blockedHint = (err) => (client.routes.length > 1
    ? `Instagram rate-limited every network route this run tried (${client.routes.map((r) => r.label).join(', ')}). Run again in 10–15 minutes. If it keeps failing, send the DIAGNOSTICS record to the developer. Last reply: ${err?.message ?? 'unknown'}`
    : `Instagram blocked the request. This run used ${proxyLabel}. Turn on "Automatic proxy fallback", or switch Proxy configuration (Apify datacenter or RESIDENTIAL), and run again.`);

const WALL_TEXT = {
    comments: 'Comments', mentions: 'Mentions (tagged posts)', details: 'These details', posts: 'These posts', reels: 'These reels',
};
const loginHint = () => `${WALL_TEXT[opts.resultsType] ?? 'This data'} currently require a logged-in Instagram account for this input — Instagram showed its login wall on every method. Not charged. Profile posts and reels work without login; hashtags, places, comments and mentions are often walled. Run again later, as Instagram changes these walls often.`;

function saveFailed(t, status, error, fixHint) {
    bump(summary.statusCounts, status);
    t.rec.status = status;
    t.rec.error = error;
    if (!opts.includeFailedInputs) return chain;
    chain = chain.then(async () => {
        await Actor.pushData({
            status, inputUrl: t.inputUrl, resultsType: opts.resultsType, error, fixHint: fixHint ?? FIX[status] ?? FIX.error,
            searchTerm: t.searchTerm ?? null, scrapedAt: new Date().toISOString(),
        }); // no event name -> never charged
        summary.failedRowsSaved += 1;
    });
    return chain;
}

/**
 * Saves one result. Returns {saved, reason}. Filters, dedupe, limits and charging all happen here.
 * kind: post | comment | profile | hashtag | place
 */
function emit(t, kind, row, method) {
    const event = ['profile', 'hashtag', 'place'].includes(kind) ? EVENT_DETAILS : EVENT_ITEM;
    if (kind === 'post') {
        if (opts.skipPinnedPosts && row.isPinned) return Promise.resolve({ saved: false, reason: 'filtered_pinned_post' });
        if (newerThan && row.timestamp && Date.parse(row.timestamp) < newerThan.getTime()) return Promise.resolve({ saved: false, reason: 'filtered_older_than_date', old: true, pinned: row.isPinned });
        if (opts.minLikes && !(row.likesCount >= opts.minLikes)) return Promise.resolve({ saved: false, reason: row.likesCount === null ? 'filtered_likes_hidden' : 'filtered_below_min_likes' });
        if (opts.minComments && !(row.commentsCount >= opts.minComments)) return Promise.resolve({ saved: false, reason: 'filtered_below_min_comments' });
    }
    const key = `${kind}:${row.id ?? row.username ?? row.name ?? row.locationId}`;
    if (seenRun.has(key)) return Promise.resolve({ saved: false, reason: 'duplicate_in_run' });
    if (seenPrev.has(key)) return Promise.resolve({ saved: false, reason: 'seen_in_previous_run' });
    seenRun.add(key);
    const full = {
        status: 'ok', resultType: kind === 'post' ? (opts.resultsType === 'mentions' ? 'mention' : row.isReel ? 'reel' : 'post') : kind === 'comment' && row.isReply ? 'reply' : kind,
        inputUrl: t.inputUrl, ...row,
        ...(t.searchTerm ? { searchTerm: t.searchTerm, searchSource: t.searchSource } : {}),
        ...(opts.addParentData && t.parent ? { parentData: t.parent } : {}),
        dataSource: method ?? null, scrapedAt: new Date().toISOString(),
    };
    const p = chain.then(async () => {
        if (stopReason) return { saved: false, reason: 'not_saved_run_stopping' };
        if (opts.maxItems && summary.saved >= opts.maxItems) {
            stop('max_items_reached');
            return { saved: false, reason: 'not_saved_run_stopping' };
        }
        if (pricing.isPayPerEvent && charging.calculateMaxEventChargeCountWithinLimit(event) <= 0) {
            stop('max_cost_per_run_reached');
            return { saved: false, reason: 'not_saved_max_cost_reached' };
        }
        const res = await Actor.pushData(full, event);
        summary.saved += 1;
        bump(summary.savedByType, full.resultType);
        summary.chargedEvents[event] += res?.chargedCount ?? 0;
        if (seenStore) seenPrev.add(key);
        if (kind === 'comment' && row.isReply) t.rec.repliesSaved = (t.rec.repliesSaved ?? 0) + 1; // replies don't count toward the per-URL limit
        else t.rec.saved += 1;
        if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        if (opts.maxItems && summary.saved >= opts.maxItems) stop('max_items_reached');
        if (summary.saved % PROGRESS_EVERY === 0) {
            const min = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
            log.info(`Progress: ${summary.saved} results saved, ${Math.round(summary.saved / min)}/min, ${summary.requests.requests} requests.`);
        }
        return { saved: true };
    });
    chain = p.then(() => {}, () => {});
    return p;
}

const note = (t, reason) => {
    bump(summary.skipReasons, reason);
    bump(t.rec.skipped, reason);
};
const full = (t) => t.rec.saved >= opts.resultsLimit || Boolean(stopReason);

/** Emits a page of posts; returns true when the target should stop paginating (limit or date cutoff). */
async function emitPosts(t, posts, method, { ordered, followers, filter } = {}) {
    let oldInRow = 0;
    for (const p of posts) {
        if (!p) continue;
        if (full(t)) return true;
        if (filter && !filter(p)) {
            note(t, 'filtered_not_a_reel');
            continue;
        }
        if (followers && p.likesCount !== null) p.engagementRate = Math.round((((p.likesCount ?? 0) + (p.commentsCount ?? 0)) / followers) * 10000) / 100;
        else p.engagementRate ??= null;
        p.ownerFollowersCount = followers ?? null;
        const r = await emit(t, 'post', p, method);
        if (!r.saved) note(t, r.reason);
        if (r.old && !r.pinned) oldInRow += 1;
        else if (!r.old) oldInRow = 0;
        if (ordered && oldInRow >= 3) {
            note(t, 'stopped_reached_date_limit');
            return true;
        }
    }
    return full(t);
}

/** Generic paginator with a guard against endless repeats. */
async function paginate(t, first, fetchPage, emitPage) {
    let cursor = first;
    let emptyPages = 0;
    let pages = 0;
    while (cursor && !full(t) && pages < 2000) {
        pages += 1;
        let page;
        try {
            page = await fetchPage(cursor);
        } catch (err) {
            if (err instanceof StoppedError) return;
            t.rec.paginationStoppedBy = err.message.slice(0, 300);
            return;
        }
        t.rec.methods.add(page.method);
        const before = t.rec.saved;
        if (await emitPage(page.data, page.method)) return;
        emptyPages = t.rec.saved === before ? emptyPages + 1 : 0;
        if (emptyPages >= 4) {
            t.rec.paginationStoppedBy = 'four pages in a row added nothing new';
            return;
        }
        cursor = page.data.next;
    }
}

// ---------- Handlers ----------

/** Cursor after the 12 posts that come with a full profile: GraphQL end_cursor plus the mobile-API max_id (last post ID). */
function firstCursor(user) {
    const tc = user.edge_owner_to_timeline_media;
    if (!tc?.page_info?.has_next_page) return null;
    const last = tc.edges?.[tc.edges.length - 1]?.node?.id;
    return { graph: tc.page_info.end_cursor, v1: last ? `${last}_${user.id}` : undefined };
}

const MISSING_WITHOUT_PROFILE = ['biography', 'externalUrl', 'followsCount', 'businessEmail', 'businessPhone', 'businessCategoryName', 'relatedProfiles', 'highlightReelCount'];

/**
 * Loads a profile. Full profile data (followers, bio, contacts) comes from Instagram's profile endpoint when it answers;
 * otherwise the posts feed (works logged-out) supplies the account, its ID and latest posts, plus page meta for counts.
 * @returns {{ user:{id,username}, profile:object, posts:object[], cursor:object|null, method:string, partial:boolean }}
 */
async function loadProfile(t, session, { wantFull }) {
    let feed = null;
    if (t.kind === 'profileId') {
        const r = await ep.feedById(t.value, null, session);
        t.rec.methods.add(r.method);
        const username = r.data.user?.username ?? r.data.posts.find((p) => p.ownerId === t.value)?.ownerUsername;
        if (!username) throw new NotFoundError(`no public account or posts found for profile ID ${t.value}`);
        feed = { ...r, data: { ...r.data, user: { ...r.data.user, username } } };
        t.value = username;
        t.kind = 'profile';
        t.rec.resolvedTo = `@${username}`;
    }
    // 1) full profile, unless this run already proved it is login-walled
    if (wantFull && !client.diag.hopeless('profile:web_profile_info')) {
        try {
            const r = await ep.profileInfo(t.value, session);
            t.rec.methods.add(r.method);
            const u = r.data;
            return { user: { id: String(u.id), username: u.username }, profile: profileFromUser(u), posts: (u.edge_owner_to_timeline_media?.edges ?? []).map((e) => postFromGraph(e.node)), cursor: firstCursor(u), method: r.method, partial: false };
        } catch (err) {
            if (err instanceof NotFoundError || err instanceof StoppedError) throw err;
            t.rec.profileEndpoint = err.message.slice(0, 200);
        }
    }
    // 2) posts feed: account, ID and latest posts
    if (!feed) {
        feed = await ep.feedByUsername(t.value, null, session);
        t.rec.methods.add(feed.method);
    }
    const fu = feed.data.user ?? {};
    let meta = null;
    if (opts.resultsType === 'details' && !client.diag.hopeless('profile:page_meta')) {
        try {
            const m = await ep.profileMeta(t.value, session);
            t.rec.methods.add(m.method);
            meta = m.data;
        } catch (err) {
            if (err instanceof StoppedError) throw err;
        }
    }
    const synth = {
        id: fu.id, username: fu.username ?? t.value, full_name: fu.full_name ?? meta?.fullName ?? null, is_private: fu.is_private, is_verified: fu.is_verified,
        profile_pic_url: fu.profile_pic_url, follower_count: meta?.followers ?? undefined, following_count: meta?.following ?? undefined,
        media_count: meta?.posts ?? undefined, biography: meta?.bio ?? '',
    };
    const profile = profileFromUser(synth, { posts: feed.data.posts });
    const missing = MISSING_WITHOUT_PROFILE.filter((f) => !(f === 'biography' && meta?.bio) && !(f === 'followsCount' && meta?.following !== undefined));
    if (meta?.followers === undefined || meta === null) missing.unshift('followersCount', 'postsCount', 'engagementRate');
    profile.dataCompleteness = 'partial';
    profile.missingFields = missing;
    profile.missingReason = 'Instagram login-walled the full profile endpoint for this run; data comes from the public posts feed'
        + (meta ? ' and the profile page (counts may be rounded, e.g. 283M).' : '.');
    if (meta) profile.countsApproximate = meta.approximate;
    return { user: { id: fu.id, username: profile.username }, profile, posts: feed.data.posts, cursor: feed.data.next, method: feed.method, partial: true };
}

async function handleProfile(t, session) {
    if (opts.resultsType === 'comments') {
        return saveFailed(t, 'unsupported_combination', 'comments need post or reel URLs', 'Comments are scraped from post/reel URLs. For a profile, choose "posts", "reels", "mentions" or "details".');
    }
    const loaded = await loadProfile(t, session, { wantFull: opts.resultsType === 'details' || opts.resultsType === 'posts' });
    const { profile, user, method } = loaded;
    t.parent = { type: 'profile', username: profile.username, fullName: profile.fullName, followersCount: profile.followersCount, verified: profile.verified };
    if (opts.resultsType === 'details') {
        const r = await emit(t, 'profile', profile, method);
        if (!r.saved) note(t, r.reason);
        return;
    }
    if (profile.private) return saveFailed(t, 'private', `@${profile.username} is a private account`);
    if (!user.id) throw new BlockedError('could not read the account ID');
    const followers = profile.followersCount;
    if (opts.resultsType === 'posts') {
        if (await emitPosts(t, loaded.posts, method, { ordered: true, followers })) return;
        await paginate(t, loaded.cursor, (c) => ep.timelinePage(user, c, session), (d, m) => emitPosts(t, d.posts, m, { ordered: true, followers }));
    } else if (opts.resultsType === 'reels') {
        let clipsFailed = false;
        await paginate(t, 'start', async (c) => {
            try {
                return await ep.reelsPage(user, c === 'start' ? null : c, session);
            } catch (err) {
                clipsFailed = true;
                throw err;
            }
        }, (d, m) => emitPosts(t, d.posts, m, { ordered: true, followers }));
        if (clipsFailed && !full(t)) { // fallback: reels from the main feed
            t.rec.reelsSource = 'filtered from profile posts (reels tab unavailable)';
            const isReel = (p) => p.productType === 'clips';
            if (await emitPosts(t, loaded.posts, method, { ordered: true, followers, filter: isReel })) return;
            await paginate(t, loaded.cursor, (c) => ep.timelinePage(user, c, session), (d, m) => emitPosts(t, d.posts, m, { ordered: true, followers, filter: isReel }));
        }
    } else if (opts.resultsType === 'mentions') {
        await paginate(t, { first: true }, (c) => ep.taggedPage(user, c.first ? null : c, session), (d, m) => emitPosts(t, d.posts, m, { ordered: true }));
    }
}

async function handlePost(t, session) {
    let media = null;
    let method = null;
    try {
        ({ data: media, method } = await ep.postByShortcode(t.value, session));
        t.rec.methods.add(method);
    } catch (err) {
        if (opts.resultsType !== 'comments' || err instanceof NotFoundError || err instanceof StoppedError) throw err;
        t.rec.postDetailsError = err.message.slice(0, 200); // comments can still work without the post itself
    }
    if (opts.resultsType !== 'comments') {
        const p = normalizePost(media);
        if (media?.__partial) p.dataCompleteness = 'partial (embed page only — counts unavailable)';
        if (opts.resultsType === 'reels' && p.productType !== 'clips') return saveFailed(t, 'unsupported_combination', 'this URL is a post, not a reel', 'Choose "posts" or "details" for regular posts.');
        const r = await emit(t, 'post', p, method);
        if (!r.saved) note(t, r.reason);
        return;
    }
    // comments
    const sc = t.value;
    const post = media ? normalizePost(media) : null;
    if (post) t.parent = { type: 'post', shortCode: sc, ownerUsername: post.ownerUsername, likesCount: post.likesCount, commentsCount: post.commentsCount };
    if (post?.isCommentsDisabled) return saveFailed(t, 'no_results', 'comments are turned off on this post', 'The owner disabled comments.');
    const handleReplies = async (c, raw) => {
        if (!opts.includeNestedComments || !c.repliesCount) return;
        const pre = (raw?.edge_threaded_comments?.edges ?? []).map((e) => commentFromGraph(e.node, sc, c.id))
            .concat((raw?.preview_child_comments ?? []).map((x) => commentFromV1(x, sc, c.id))).filter(Boolean);
        for (const rc of pre) {
            const r = await emit(t, 'comment', rc, 'preview');
            if (!r.saved) note(t, r.reason);
        }
        if (pre.length >= c.repliesCount) return;
        let cursor = null;
        for (let i = 0; i < 50 && !stopReason; i++) {
            let page;
            try {
                page = await ep.childCommentsPage(sc, c.id, cursor, session);
            } catch {
                note(t, 'replies_unavailable');
                return;
            }
            for (const rc of page.data.comments) {
                const r = await emit(t, 'comment', rc, page.method);
                if (!r.saved) note(t, r.reason);
            }
            cursor = page.data.next;
            if (!cursor) return;
        }
    };
    const emitComments = async (list, m) => {
        for (const { c, raw } of list) {
            if (!c) continue;
            if (full(t)) return true;
            const r = await emit(t, 'comment', c, m);
            if (!r.saved) note(t, r.reason);
            else if (opts.includeNestedComments) await handleReplies(c, raw);
        }
        return full(t);
    };
    // First page comes free with the post (Instagram's default order) unless newest-first was requested.
    const conn = media?.edge_media_to_parent_comment;
    if (!opts.isNewestComments && conn?.edges?.length) {
        if (await emitComments(conn.edges.map((e) => ({ c: commentFromGraph(e.node, sc), raw: e.node })), method)) return;
        if (!conn.page_info?.has_next_page) return;
        await paginate(t, { graph: conn.page_info.end_cursor }, (c) => ep.commentsPage(sc, c, { newest: false }, session), (d, m) => emitComments(d.comments, m));
        return;
    }
    await paginate(t, { first: true }, (c) => ep.commentsPage(sc, c.first ? null : c, { newest: opts.isNewestComments }, session), (d, m) => emitComments(d.comments, m));
    if (!t.rec.saved && post && post.commentsCount === 0) return saveFailed(t, 'no_results', 'this post has no comments', 'Nothing to scrape.');
}

async function handleHashtag(t, session) {
    if (['comments', 'mentions'].includes(opts.resultsType)) {
        return saveFailed(t, 'unsupported_combination', `${opts.resultsType} are not available for hashtags`, 'For hashtags choose "posts", "reels" or "details".');
    }
    const { data: h, method } = await ep.hashtagInfo(t.value, session);
    t.rec.methods.add(method);
    t.parent = { type: 'hashtag', name: h.name, postsCount: h.postsCount };
    const sample = [...h.topPosts, ...h.recentPosts];
    if (opts.resultsType === 'details') {
        const ppd = postsPerDayFromPosts(h.recentPosts);
        const row = {
            id: h.name, name: h.name, url: `https://www.instagram.com/explore/tags/${encodeURIComponent(h.name)}/`, postsCount: h.postsCount,
            profilePicUrl: h.profilePicUrl, postsPerDayEstimate: ppd.value, postsPerDayBasis: ppd.basis,
            relatedHashtags: sample.length ? relatedFromPosts(h.name, sample) : [], relatedBasis: sample.length ? `co-occurring hashtags in ${sample.length} sampled posts` : 'no posts returned — related hashtags unavailable',
            topPosts: h.topPosts.slice(0, 9), latestPosts: h.recentPosts.slice(0, 12),
        };
        const r = await emit(t, 'hashtag', row, method);
        if (!r.saved) note(t, r.reason);
        return;
    }
    const filter = opts.resultsType === 'reels' ? (p) => p.productType === 'clips' : null;
    if (await emitPosts(t, h.topPosts, method, { filter })) return;
    if (await emitPosts(t, h.recentPosts, method, { ordered: true, filter })) return;
    const start = h.moreAvailable && h.nextCursor ? { max_id: h.nextCursor, page: h.nextPage } : null;
    await paginate(t, start, (c) => ep.sectionsPage('hashtag', h.name, c, session), (d, m) => emitPosts(t, d.posts, m, { ordered: true, filter }));
}

async function handlePlace(t, session) {
    if (['comments', 'mentions'].includes(opts.resultsType)) {
        return saveFailed(t, 'unsupported_combination', `${opts.resultsType} are not available for places`, 'For places choose "posts", "reels" or "details".');
    }
    const { data: pl, method } = await ep.placeInfo(t.value, session);
    t.rec.methods.add(method);
    t.parent = { type: 'place', locationId: pl.locationId, name: pl.name };
    if (opts.resultsType === 'details') {
        const { topPosts, recentPosts, nextCursor, nextPage, moreAvailable, ...rest } = pl;
        const row = { id: pl.locationId, ...rest, url: `https://www.instagram.com/explore/locations/${pl.locationId}/`, topPosts: topPosts.slice(0, 9), latestPosts: recentPosts.slice(0, 12) };
        const r = await emit(t, 'place', row, method);
        if (!r.saved) note(t, r.reason);
        return;
    }
    const filter = opts.resultsType === 'reels' ? (p) => p.productType === 'clips' : null;
    if (await emitPosts(t, pl.topPosts, method, { filter })) return;
    if (await emitPosts(t, pl.recentPosts, method, { ordered: true, filter })) return;
    const start = pl.moreAvailable && pl.nextCursor ? { max_id: pl.nextCursor, page: pl.nextPage } : null;
    await paginate(t, start, (c) => ep.sectionsPage('place', pl.locationId, c, session), (d, m) => emitPosts(t, d.posts, m, { ordered: true, filter }));
}

async function processTarget(t) {
    const session = new Session();
    try {
        if (t.kind === 'share') {
            const r = await ep.resolveShare(t.value, session);
            t.rec.methods.add(r.method);
            Object.assign(t, { kind: r.data.kind, value: r.data.value, hint: r.data.hint });
            t.rec.resolvedTo = `${t.kind}:${t.value}`;
        }
        if (t.kind === 'profile' || t.kind === 'profileId') await handleProfile(t, session);
        else if (t.kind === 'post') await handlePost(t, session);
        else if (t.kind === 'hashtag') await handleHashtag(t, session);
        else if (t.kind === 'location') await handlePlace(t, session);
        if (t.rec.status === 'pending') {
            t.rec.status = t.rec.saved ? 'ok' : 'no_results';
            if (!t.rec.saved && !t.rec.repliesSaved && /^Instagram requires a login/.test(t.rec.paginationStoppedBy ?? '')) {
                await saveFailed(t, 'login_required', t.rec.paginationStoppedBy.slice(0, 600), loginHint());
            } else if (!t.rec.saved && !t.rec.repliesSaved && /^every method failed/.test(t.rec.paginationStoppedBy ?? '')) {
                await saveFailed(t, 'blocked', t.rec.paginationStoppedBy.slice(0, 600), blockedHint({ message: t.rec.paginationStoppedBy }));
            } else if (!t.rec.saved && Object.keys(t.rec.skipped).length === 1 && t.rec.skipped.duplicate_in_run) {
                await saveFailed(t, 'duplicate_input', `same ${t.kind === 'post' ? 'post' : 'account'} as another input in this run${t.rec.resolvedTo ? ` (${t.rec.resolvedTo})` : ''}`, 'Already scraped from the other input — its results are in the dataset. Not charged twice.');
            } else if (!t.rec.saved) {
                const reasons = Object.entries(t.rec.skipped).map(([k, v]) => `${v}× ${k}`).join(', ');
                await saveFailed(t, 'no_results', reasons ? `nothing passed the filters (${reasons})` : (t.rec.paginationStoppedBy ?? 'Instagram returned no items'),
                    reasons ? 'Loosen the filters (date, min likes/comments, skip pinned) or raise the results limit.' : 'The account/hashtag/place may have no public items, or loading more pages was blocked — see the error and DIAGNOSTICS.');
            } else bump(summary.statusCounts, 'ok');
        }
    } catch (err) {
        if (err instanceof StoppedError) {
            t.rec.status = 'not_finished_run_stopped';
            return;
        }
        if (err instanceof NotFoundError) return saveFailed(t, 'not_found', err.message);
        if (err instanceof LoginWallError) {
            log.warning(`${t.inputUrl}: ${err.message}`);
            return saveFailed(t, 'login_required', err.message.slice(0, 600), loginHint());
        }
        if (err instanceof BlockedError) {
            log.warning(`${t.inputUrl}: ${err.message}`);
            return saveFailed(t, 'blocked', err.message.slice(0, 600), blockedHint(err));
        }
        log.exception(err, `Unexpected error on ${t.inputUrl}`);
        return saveFailed(t, 'error', err.message);
    }
}

// ---------- Build targets ----------
const targets = [];
const newRec = (t) => ({ inputUrl: t.inputUrl, kind: t.kind, status: 'pending', saved: 0, skipped: {}, methods: new Set() });
const dedupe = new Set();
for (const raw of opts.directUrls) {
    const t = parseTarget(raw);
    if (!t) continue;
    if (t.invalid) {
        const rec = { inputUrl: t.inputUrl, kind: 'invalid', status: 'pending', saved: 0, skipped: {}, methods: new Set() };
        summary.perInput.push(rec);
        await saveFailed({ inputUrl: t.inputUrl, rec }, 'invalid_input', t.error);
        continue;
    }
    const key = `${t.kind}:${t.value}`;
    if (dedupe.has(key)) {
        bump(summary.skipReasons, 'duplicate_input_url');
        continue;
    }
    dedupe.add(key);
    t.rec = newRec(t);
    summary.perInput.push(t.rec);
    targets.push(t);
}

if (!opts.directUrls.length && opts.search.length) {
    log.info(`Searching Instagram for ${opts.search.length} term(s) as ${opts.searchType}…`);
    const session = new Session();
    for (const term of opts.search) {
        if (stopReason) break;
        const rec = { inputUrl: `search: ${term}`, kind: `search:${opts.searchType}`, status: 'pending', saved: 0, skipped: {}, methods: new Set() };
        summary.perInput.push(rec);
        try {
            const r = await ep.search(term, opts.searchType, session);
            rec.methods.add(r.method);
            const found = r.data.filter((x) => !dedupe.has(`${x.kind}:${x.value}`)).slice(0, opts.searchLimit);
            rec.found = found.length;
            rec.status = found.length ? 'ok' : 'no_results';
            if (!found.length) await saveFailed({ inputUrl: rec.inputUrl, rec, searchTerm: term }, 'no_results', `no ${opts.searchType} results for "${term}"`, 'Try a broader term. Place searches work best as "business type + city", e.g. "vintage shop copenhagen".');
            for (const x of found) {
                dedupe.add(`${x.kind}:${x.value}`);
                const url = x.kind === 'profile' ? `https://www.instagram.com/${x.value}/` : x.kind === 'hashtag' ? `https://www.instagram.com/explore/tags/${x.value}/` : `https://www.instagram.com/explore/locations/${x.value}/`;
                const t = { kind: x.kind, value: x.value, inputUrl: url, searchTerm: term, searchSource: r.method.includes('duckduckgo') ? 'duckduckgo' : 'instagram' };
                t.rec = newRec(t);
                summary.perInput.push(t.rec);
                targets.push(t);
            }
        } catch (err) {
            if (err instanceof StoppedError) break;
            await saveFailed({ inputUrl: rec.inputUrl, rec, searchTerm: term }, err instanceof LoginWallError ? 'login_required' : 'blocked', `search failed: ${err.message.slice(0, 400)}`, err instanceof LoginWallError ? loginHint() : blockedHint(err));
        }
    }
}
summary.inputs = targets.length;
if (!targets.length && !summary.failedRowsSaved) log.warning('Nothing to scrape: add Instagram URLs to "directUrls" or a search term to "search".');
log.info(`Scraping ${targets.length} input(s), up to ${opts.resultsLimit} ${opts.resultsType} each, ${Math.min(CONCURRENCY, targets.length || 1)} in parallel.`);

const queue = [...targets];
// The first input runs alone so the run learns which Instagram methods work (and which are login-walled)
// before 25 inputs hit them in parallel — avoids paying for the same dead end many times.
if (queue.length && !stopReason) await processTarget(queue.shift());
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !stopReason && msLeft() > 0) await processTarget(queue.shift());
}));
await chain;

// ---------- Summary ----------
summary.stopReason = stopReason ?? 'completed';
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.perInput = summary.perInput.map((r) => ({ ...r, methods: [...(r.methods ?? [])] }));
summary.notProcessed = summary.perInput.filter((r) => r.status === 'pending' || r.status === 'not_finished_run_stopped').length;
const diag = client.diag.toJSON();
summary.methodsThatWorked = Object.entries(diag).filter(([, v]) => v.successes).map(([k, v]) => `${k} (${v.successes}/${v.attempts})`);
summary.methodsThatFailed = Object.entries(diag).filter(([, v]) => !v.successes).map(([k, v]) => `${k} (0/${v.attempts}: ${v.lastProblem})`);
summary.routes = client.routesSummary();
await Actor.setValue('RUN_SUMMARY', summary);
await Actor.setValue('DIAGNOSTICS', { note: 'Per-method results for this run. Send this record to the developer if inputs come back "blocked".', proxy: proxyLabel, routes: summary.routes, methods: diag });
if (seenStore) await seenStore.setValue('SEEN_IDS', [...seenPrev]);
const failedInputs = summary.perInput.filter((r) => !['ok'].includes(r.status)).length;
const msg = `Saved ${summary.saved} results from ${summary.perInput.length - failedInputs}/${summary.perInput.length} inputs. Stop reason: ${summary.stopReason}.${summary.saved === 0 && summary.statusCounts.blocked ? ` Instagram blocked the requests on every route tried (${client.routes.slice(0, client.routeIdx + 1).map((r) => r.label).join(', ')}).` : ''} See RUN_SUMMARY.`;
log.info(msg);
await Actor.exit({ statusMessage: msg });
