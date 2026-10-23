// Instagram endpoints. Every operation has an ordered list of fallback methods; the client tries them in order,
// retries blocks on fresh IPs, and records what worked in DIAGNOSTICS.
import { WWW, API, DDG, check, NotFoundError, ShapeError } from './client.js';
import { postFromGraph, postFromV1, normalizePost, commentFromGraph, commentFromV1, mediaFromTree, hashtagFromJson, placeFromJson, placeFromHtml } from './parse.js';
import { shortcodeToId, parseTarget } from './urls.js';

const enc = encodeURIComponent;
const vars = (o) => enc(JSON.stringify(o));
const POST_DOC_ID = '8845758582119845';
const HASH = {
    timeline: '69cba40317214236af40e7efa697781d',
    tagged: 'be13233562af2d229b008d2976b998b5',
    comments: 'bc3296d1ce80a24b1b6e40b1e72903f5',
    post: 'b3055c01b4b222b8a47dc12b090e4e64',
};

/**
 * Orders fallback methods for a pagination cursor. Methods whose own cursor key is present continue the page;
 * from a GraphQL-only cursor the others may restart from the top (duplicates are skipped); a v1 cursor never restarts.
 */
const onlyCompatible = (cursor, methods) => {
    if (!cursor || cursor.first) return methods;
    const can = methods.filter((m) => m.key && cursor[m.key]);
    const restart = cursor.v1 ? [] : methods.filter((m) => !(m.key && cursor[m.key]));
    return [...can, ...restart];
};

export function makeEndpoints(client) {
    const req = (o) => client.request(o).then(check);

    // ---------- Profiles ----------
    // Full profile (followers, bio, contacts). Instagram often login-walls this for logged-out visitors.
    const profileInfo = (username, session) => client.run(['web', 'mobile'].flatMap((style) => [WWW].map((base) => ({
        name: `profile:web_profile_info(${style})`,
        notFoundIsFinal: true,
        attempts: 1,
        fn: async (s) => {
            const r = await req({ url: `${base}/api/v1/users/web_profile_info/?username=${enc(username)}`, style, session: s, referer: `https://www.instagram.com/${username}/`, name: 'profile_web_profile_info' });
            if (!r.json?.data || !('user' in r.json.data)) throw new ShapeError('no data.user in response');
            if (!r.json.data.user) throw new NotFoundError('account does not exist or is restricted');
            return r.json.data.user;
        },
    }))), session);

    // Counts and bio from the public profile page's meta tags (works when the page is served to logged-out visitors).
    const profileMeta = (username, session) => client.run([{
        name: 'profile:page_meta',
        attempts: 2,
        fn: async (s) => {
            const r = await req({ url: `${WWW}/${enc(username)}/`, style: 'html', expect: 'html', session: s, name: 'profile_page_meta' });
            return metaFromProfileHtml(r.body) ?? (() => { throw new ShapeError('no profile meta tags'); })();
        },
    }], session);

    // Posts feed — verified working logged-out (mobile app style on www.instagram.com, Oct 2026).
    const feedParse = (r, fallbackUsername) => {
        if (!Array.isArray(r.json?.items)) throw new ShapeError('no items');
        const items = r.json.items;
        const top = r.json.user ?? items[0]?.user ?? null;
        const user = top ? {
            id: String(top.pk ?? top.id ?? ''), username: top.username ?? items[0]?.user?.username ?? fallbackUsername ?? null, full_name: top.full_name ?? null,
            is_private: Boolean(top.is_private), is_verified: Boolean(top.is_verified), profile_pic_url: top.profile_pic_url ?? null,
        } : null;
        return { user, posts: items.map(postFromV1), next: r.json.more_available && r.json.next_max_id ? { v1: r.json.next_max_id } : null };
    };
    // Measured Oct 2026: the username feed works logged-out (8/8 from a datacenter IP); the ID feed mostly 401s;
    // i.instagram.com always answers 403. So: username feed first (Android, then iOS client), ID feed last.
    const feedUrl = (key, cursor) => `${WWW}/api/v1/feed/user/${enc(key)}/${/^\d+$/.test(String(key)) ? '' : 'username/'}?count=12${cursor?.v1 ? `&max_id=${enc(cursor.v1)}` : ''}`;
    const feedMethods = (keys, cursor, referer) => keys.flatMap(([label, key]) => ['mobile', 'ios'].map((style) => ({
        name: `posts:v1_feed_${label}(${style === 'ios' ? 'ios' : 'android'})`,
        key: 'v1',
        notFoundIsFinal: label === 'username' && style === 'mobile',
        fn: async (s) => feedParse(await req({ url: feedUrl(key, cursor), style, session: s, referer, name: `feed_${label}` }), label === 'username' ? key : undefined),
    })));
    const feedByUsername = (username, cursor, session) => client.run(feedMethods([['username', username]], cursor, `https://www.instagram.com/${username}/`), session);
    const feedById = (id, cursor, session) => client.run(feedMethods([['user', id]], cursor), session);

    // ---------- Profile posts (pagination) ----------
    const timelinePage = (user, cursor, session) => client.run(onlyCompatible(cursor, [
        ...feedMethods(user.username ? [['username', user.username], ['user', user.id]] : [['user', user.id]], cursor, `https://www.instagram.com/${user.username}/`),
        {
            name: 'posts:graphql_timeline',
            key: 'graph',
            fn: async (s) => {
                await client.warm(s);
                const r = await req({ url: `${WWW}/graphql/query/?query_hash=${HASH.timeline}&variables=${vars({ id: user.id, first: 12, after: cursor?.graph ?? undefined })}`, session: s, referer: `https://www.instagram.com/${user.username}/`, name: 'posts_graphql_timeline' });
                const c = r.json?.data?.user?.edge_owner_to_timeline_media;
                if (!c) throw new ShapeError('no edge_owner_to_timeline_media');
                const last = c.edges[c.edges.length - 1]?.node?.id;
                return { posts: c.edges.map((e) => postFromGraph(e.node)), next: c.page_info?.has_next_page ? { graph: c.page_info.end_cursor, v1: last ? `${last}_${user.id}` : undefined } : null };
            },
        },
    ]), session);

    // ---------- Reels tab (verified working logged-out in the mobile style) ----------
    const reelsPage = (user, cursor, session) => client.run(['mobile', 'ios', 'web'].map((style) => ({
        name: `reels:v1_clips_user(${style === 'mobile' ? 'android' : style})`,
        fn: async (s) => {
            const form = { target_user_id: user.id, page_size: '12', include_feed_video: 'true' };
            if (cursor) form.max_id = cursor;
            const r = await req({ method: 'POST', url: `${WWW}/api/v1/clips/user/`, form, style, session: s, referer: `https://www.instagram.com/${user.username}/reels/`, name: 'reels_v1_clips_user' });
            if (!Array.isArray(r.json?.items)) throw new ShapeError('no items');
            const p = r.json.paging_info ?? {};
            return { posts: r.json.items.map((it) => postFromV1(it.media ?? it)), next: p.more_available && p.max_id ? p.max_id : null };
        },
    })), session);

    // ---------- Tagged posts (mentions) ----------
    const taggedPage = (user, cursor, session) => client.run(onlyCompatible(cursor, [
        {
            name: 'mentions:graphql_tagged',
            key: 'graph',
            fn: async (s) => {
                await client.warm(s);
                const r = await req({ url: `${WWW}/graphql/query/?query_hash=${HASH.tagged}&variables=${vars({ id: user.id, first: 12, after: cursor?.graph ?? undefined })}`, session: s, referer: `https://www.instagram.com/${user.username}/tagged/`, name: 'mentions_graphql_tagged' });
                const c = r.json?.data?.user?.edge_user_to_photos_of_you;
                if (!c) throw new ShapeError('no edge_user_to_photos_of_you');
                return { posts: c.edges.map((e) => postFromGraph(e.node)), next: c.page_info?.has_next_page ? { graph: c.page_info.end_cursor } : null };
            },
        },
        {
            name: 'mentions:v1_usertags(mobile)',
            key: 'v1',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/api/v1/usertags/${user.id}/feed/?count=12${cursor?.v1 ? `&max_id=${enc(cursor.v1)}` : ''}`, style: 'mobile', session: s, name: 'mentions_v1_usertags' });
                if (!Array.isArray(r.json?.items)) throw new ShapeError('no items');
                return { posts: r.json.items.map(postFromV1), next: r.json.more_available && r.json.next_max_id ? { v1: r.json.next_max_id } : null };
            },
        },
    ]), session);

    // ---------- Single post / reel ----------
    const graphPostVars = (sc) => ({ shortcode: sc, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null });
    const xdt = (r) => {
        const d = r.json?.data;
        if (!d || !('xdt_shortcode_media' in d)) throw new ShapeError('no data.xdt_shortcode_media');
        if (!d.xdt_shortcode_media) throw new NotFoundError('post not found, deleted or private');
        return d.xdt_shortcode_media;
    };
    const postByShortcode = (sc, session) => client.run([
        {
            name: 'post:graphql_doc(POST)',
            notFoundIsFinal: true,
            fn: async (s) => { await client.warm(s); return xdt(await req({ method: 'POST', url: `${WWW}/graphql/query`, form: { variables: JSON.stringify(graphPostVars(sc)), doc_id: POST_DOC_ID }, session: s, referer: `https://www.instagram.com/p/${sc}/`, name: 'post_graphql_doc_post' })); },
        },
        {
            name: 'post:graphql_doc(GET)',
            fn: async (s) => { await client.warm(s); return xdt(await req({ url: `${WWW}/graphql/query/?doc_id=${POST_DOC_ID}&variables=${vars(graphPostVars(sc))}`, session: s, referer: `https://www.instagram.com/p/${sc}/`, name: 'post_graphql_doc_get' })); },
        },
        {
            name: 'post:graphql_hash',
            fn: async (s) => {
                await client.warm(s);
                const r = await req({ url: `${WWW}/graphql/query/?query_hash=${HASH.post}&variables=${vars({ shortcode: sc })}`, session: s, name: 'post_graphql_hash' });
                const m = r.json?.data?.shortcode_media;
                if (m === null) throw new NotFoundError('post not found');
                if (!m) throw new ShapeError('no data.shortcode_media');
                return m;
            },
        },
        {
            name: 'post:v1_media_info(mobile)',
            fn: async (s) => {
                const r = await req({ url: `${API}/api/v1/media/${shortcodeToId(sc)}/info/`, style: 'mobile', session: s, name: 'post_v1_media_info' });
                const it = r.json?.items?.[0];
                if (!it) throw new ShapeError('no items[0]');
                return it;
            },
        },
        {
            name: 'post:embed_page',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/p/${sc}/embed/captioned/`, style: 'html', expect: 'html', session: s, name: 'post_embed' });
                if (/"pageID":"httpErrorPage"|PolarisErrorRoute/.test(r.body)) throw new ShapeError('embed page returned Instagram\'s "not available" page');
                return embedToMedia(r.body, sc);
            },
        },
    ], session);

    // ---------- Comments ----------
    const commentsPage = (sc, cursor, { newest }, session) => client.run(onlyCompatible(cursor, [
        {
            name: 'comments:v1_media_comments',
            key: 'v1',
            fn: async (s) => {
                const q = new URLSearchParams({ can_support_threading: 'true', permalink_enabled: 'false' });
                if (newest) q.set('sort_order', 'newest');
                if (cursor?.v1) q.set('min_id', cursor.v1);
                const r = await req({ url: `${WWW}/api/v1/media/${shortcodeToId(sc)}/comments/?${q}`, session: s, referer: `https://www.instagram.com/p/${sc}/`, name: 'comments_v1' });
                if (!Array.isArray(r.json?.comments)) throw new ShapeError('no comments array');
                const next = r.json.next_min_id ?? r.json.next_max_id;
                return { comments: r.json.comments.map((c) => ({ c: commentFromV1(c, sc), raw: c })), next: next && (r.json.has_more_headload_comments || r.json.has_more_comments) ? { v1: next } : null };
            },
        },
        {
            name: 'comments:graphql_hash',
            key: 'graph',
            fn: async (s) => {
                await client.warm(s);
                const r = await req({ url: `${WWW}/graphql/query/?query_hash=${HASH.comments}&variables=${vars({ shortcode: sc, first: 50, after: cursor?.graph ?? undefined })}`, session: s, name: 'comments_graphql' });
                const c = r.json?.data?.shortcode_media?.edge_media_to_parent_comment;
                if (!c) throw new ShapeError('no edge_media_to_parent_comment');
                return { comments: c.edges.map((e) => ({ c: commentFromGraph(e.node, sc), raw: e.node })), next: c.page_info?.has_next_page ? { graph: c.page_info.end_cursor } : null };
            },
        },
    ]), session);

    const childCommentsPage = (sc, commentId, cursor, session) => client.run([
        {
            name: 'replies:v1_child_comments',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/api/v1/media/${shortcodeToId(sc)}/comments/${commentId}/child_comments/${cursor ? `?max_id=${enc(cursor)}` : ''}`, session: s, name: 'replies_v1' });
                if (!Array.isArray(r.json?.child_comments)) throw new ShapeError('no child_comments');
                return { comments: r.json.child_comments.map((c) => commentFromV1(c, sc, commentId)), next: r.json.has_more_tail_child_comments && r.json.next_max_child_cursor ? r.json.next_max_child_cursor : null };
            },
        },
    ], session);

    // ---------- Hashtags ----------
    const hashtagInfo = (tag, session) => client.run([
        {
            name: 'hashtag:v1_tags_web_info',
            notFoundIsFinal: true,
            fn: async (s) => {
                const r = await req({ url: `${WWW}/api/v1/tags/web_info/?tag_name=${enc(tag)}`, session: s, referer: `https://www.instagram.com/explore/tags/${tag}/`, name: 'hashtag_web_info' });
                return hashtagFromJson(r.json, tag) ?? (() => { throw new ShapeError('unknown hashtag shape'); })();
            },
        },
        {
            name: 'hashtag:explore_a1',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/explore/tags/${enc(tag)}/?__a=1&__d=dis`, session: s, name: 'hashtag_a1' });
                return hashtagFromJson(r.json, tag) ?? (() => { throw new ShapeError('unknown hashtag shape'); })();
            },
        },
        {
            name: 'hashtag:v1_tags_info(mobile)',
            fn: async (s) => {
                const r = await req({ url: `${API}/api/v1/tags/${enc(tag)}/info/`, style: 'mobile', session: s, name: 'hashtag_v1_info' });
                return hashtagFromJson(r.json, tag) ?? (() => { throw new ShapeError('unknown hashtag shape'); })();
            },
        },
    ], session);

    const sectionsPage = (kind, key, cursor, session) => client.run([
        {
            name: `${kind}:v1_sections`,
            fn: async (s) => {
                const form = { tab: 'recent', include_persistent: '0', surface: 'grid' };
                if (cursor?.max_id) form.max_id = cursor.max_id;
                if (cursor?.page) form.page = String(cursor.page);
                const path = kind === 'hashtag' ? `tags/${enc(key)}` : `locations/${key}`;
                const r = await req({ method: 'POST', url: `${WWW}/api/v1/${path}/sections/`, form, session: s, name: `${kind}_sections` });
                if (!r.json?.sections) throw new ShapeError('no sections');
                return { posts: mediaFromTree(r.json.sections).map(postFromV1), next: r.json.more_available && r.json.next_max_id ? { max_id: r.json.next_max_id, page: r.json.next_page } : null };
            },
        },
    ], session);

    // ---------- Places ----------
    const placeInfo = (id, session) => client.run([
        {
            name: 'place:v1_locations_web_info',
            notFoundIsFinal: true,
            fn: async (s) => {
                const r = await req({ url: `${WWW}/api/v1/locations/web_info/?location_id=${id}&show_nearby=false`, session: s, referer: `https://www.instagram.com/explore/locations/${id}/`, name: 'place_web_info' });
                return placeFromJson(r.json) ?? (() => { throw new ShapeError('unknown place shape'); })();
            },
        },
        {
            name: 'place:explore_a1',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/explore/locations/${id}/?__a=1&__d=dis`, session: s, name: 'place_a1' });
                return placeFromJson(r.json) ?? (() => { throw new ShapeError('unknown place shape'); })();
            },
        },
        {
            name: 'place:page_meta',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/explore/locations/${id}/`, style: 'html', expect: 'html', session: s, name: 'place_html' });
                return placeFromHtml(r.body, id) ?? (() => { throw new ShapeError('no meta tags on location page'); })();
            },
        },
    ], session);

    // ---------- Search ----------
    const search = (query, type, session) => client.run([
        {
            name: 'search:instagram_topsearch',
            fn: async (s) => {
                const r = await req({ url: `${WWW}/web/search/topsearch/?context=blended&query=${enc(query)}&include_reel=true`, session: s, name: 'search_topsearch' });
                const j = r.json;
                if (!j || (!j.users && !j.hashtags && !j.places)) throw new ShapeError('no users/hashtags/places');
                if (type === 'user') return (j.users ?? []).map(({ user: u }) => ({ kind: 'profile', value: u.username, label: u.full_name ?? '' }));
                if (type === 'hashtag') return (j.hashtags ?? []).map(({ hashtag: h }) => ({ kind: 'hashtag', value: h.name, label: `${h.media_count ?? ''} posts` }));
                return (j.places ?? []).map(({ place: p }) => ({ kind: 'location', value: String(p.location?.pk ?? p.location?.facebook_places_id ?? ''), label: p.title ?? p.location?.name ?? '' })).filter((x) => x.value);
            },
        },
        {
            name: 'search:duckduckgo',
            attempts: 3,
            fn: async (s) => {
                const scope = type === 'hashtag' ? 'instagram.com/explore/tags' : type === 'place' ? 'instagram.com/explore/locations' : 'instagram.com';
                const r = await req({ url: `${DDG}/html/?q=${enc(`site:${scope} ${query}`)}`, style: 'html', expect: 'html', session: s, name: 'search_ddg' });
                const links = [...r.body.matchAll(/href="([^"]+)"/g)].map((m) => {
                    const h = m[1].replace(/&amp;/g, '&');
                    const u = h.match(/[?&]uddg=([^&]+)/);
                    try {
                        return u ? decodeURIComponent(u[1]) : h;
                    } catch {
                        return h;
                    }
                }).filter((h) => /instagram\.com\//i.test(h));
                const wanted = type === 'user' ? 'profile' : type === 'hashtag' ? 'hashtag' : 'location';
                const out = [];
                for (const l of links) {
                    const t = parseTarget(l);
                    if (t && !t.invalid && t.kind === wanted && !out.some((o) => o.value === t.value)) out.push({ kind: t.kind, value: t.value, label: '' });
                }
                if (!out.length && !/result/i.test(r.body)) throw new ShapeError('search page had no results block');
                return out;
            },
        },
    ], session);

    const resolveShare = (url, session) => client.run([
        {
            name: 'share:redirect',
            fn: async (s) => {
                const target = url.replace(/^https?:\/\/(?:www\.)?instagram\.com/i, WWW);
                const r = await client.request({ url: target, style: 'html', expect: 'html', session: s, name: 'share_redirect' });
                if (r.kind === 'redirect' && r.location) {
                    const t = parseTarget(new URL(r.location, 'https://www.instagram.com').href);
                    if (t && !t.invalid && t.kind !== 'share') return t;
                    throw new ShapeError(`share link redirected to ${r.location}`);
                }
                check(r);
                const canon = r.body.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? r.body.match(/property="og:url" content="([^"]+)"/)?.[1];
                const t = canon ? parseTarget(canon) : null;
                if (t && !t.invalid && t.kind !== 'share') return t;
                throw new ShapeError('could not resolve share link');
            },
        },
    ], session);

    return { profileInfo, profileMeta, feedByUsername, feedById, timelinePage, reelsPage, taggedPage, postByShortcode, commentsPage, childCommentsPage, hashtagInfo, sectionsPage, placeInfo, search, resolveShare };
}

const parseCount = (x) => {
    const m = String(x ?? '').replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1));
};

/** og:description looks like "283M Followers, 160 Following, 32K Posts - See Instagram photos and videos from National Geographic (@natgeo)". */
export function metaFromProfileHtml(html) {
    const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1]
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
    const d = (meta('og:description') ?? meta('description') ?? '').replace(/&#x2c;|&#44;/g, ',').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
    const m = d.match(/([\d.,]+[KMB]?)\s+Followers?,\s*([\d.,]+[KMB]?)\s+Following,\s*([\d.,]+[KMB]?)\s+Posts?/i);
    if (!m) return null;
    const exact = (v) => !/[KMB]$/i.test(v);
    const name = (meta('og:title') ?? '').match(/^(.*?)\s*\(@[a-z0-9._]+\)/i)?.[1]?.trim() ?? null;
    const bio = d.split(/ on Instagram:\s*"/i)[1]?.replace(/"\s*$/, '') ?? null;
    return {
        followers: parseCount(m[1]), following: parseCount(m[2]), posts: parseCount(m[3]),
        approximate: !(exact(m[1]) && exact(m[2]) && exact(m[3])), fullName: name, bio, source: `profile page meta: "${d.slice(0, 90)}"`,
    };
}

/** Embed page -> media object. Uses the embedded JSON when present, otherwise reads the visible HTML (partial data). */
export function embedToMedia(html, sc) {
    const ctx = html.match(/"contextJSON":"((?:\\.|[^"\\])*)"/);
    if (ctx) {
        try {
            const media = JSON.parse(JSON.parse(`"${ctx[1]}"`))?.context?.media ?? JSON.parse(JSON.parse(`"${ctx[1]}"`))?.gql_data?.shortcode_media;
            if (media) return media;
        } catch { /* fall through */ }
    }
    const gql = html.match(/"gql_data":(\{.*?\})\s*,\s*"/s);
    if (gql) {
        try {
            const m = JSON.parse(gql[1])?.shortcode_media;
            if (m) return m;
        } catch { /* fall through */ }
    }
    const username = html.match(/class="UsernameText"[^>]*>([^<]+)</)?.[1] ?? html.match(/instagram\.com\/([a-z0-9._]{1,30})\/\?utm_source=ig_embed/i)?.[1];
    if (!username) throw new ShapeError('embed page has no post data');
    const caption = html.match(/<div class="Caption">([\s\S]*?)<div class="CaptionComments">/)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
    const img = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
    return {
        shortcode: sc, __typename: 'GraphImage', display_url: img, owner: { username }, __partial: true,
        edge_media_to_caption: { edges: caption ? [{ node: { text: caption.replace(new RegExp(`^${username}\\s*`), '') } }] : [] },
    };
}

export { normalizePost };
