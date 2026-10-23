// Local mock of Instagram (GraphQL + mobile/v1 response shapes), DuckDuckGo search and a forward proxy.
// It reproduces the shapes the scraper expects and Instagram's blocking behaviour. Used only by test/e2e.js.
import http from 'node:http';
import { idToShortcode, shortcodeToId } from '../src/urls.js';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483647, 7);
function rng(seed) {
    let s = seed || 1;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

const USERS = {
    natgeo: { id: '787132', posts: 60, followers: 280000000, biz: false, bio: 'Experience the world through the eyes of National Geographic photographers.' },
    brand_co: { id: '5550001', posts: 30, followers: 52000, biz: true, bio: 'Handmade ceramics 🏺 Orders: hello [at] brandco [dot] com\nWhatsApp +44 7700 900123', email: 'shop@brandco.com' },
    private_acc: { id: '5550002', posts: 10, followers: 900, private: true, bio: 'just me' },
    nasawebb: { id: '549313808', posts: 40, followers: 9000000, biz: false, bio: 'Webb telescope' },
};
const ID_TO_USER = Object.fromEntries(Object.entries(USERS).map(([u, v]) => [v.id, u]));

function mediaId(owner, i) {
    return String(3000000000000000000n + BigInt(hash(owner)) * 1000n + BigInt(i));
}

/** One post in GraphQL shape. i = 0 is newest. */
function graphNode(owner, i, opts = {}) {
    const u = USERS[owner] ?? { id: '1', followers: 1000 };
    const r = rng(hash(`${owner}${i}`));
    const id = mediaId(owner, i);
    const isReel = i % 3 === 1;
    const isSidecar = i % 5 === 2;
    const likes = Math.floor(u.followers * (0.001 + r() * 0.01));
    return {
        __typename: isSidecar ? 'XDTGraphSidecar' : isReel ? 'XDTGraphVideo' : 'XDTGraphImage',
        id,
        shortcode: idToShortcode(id),
        is_video: isReel,
        product_type: isReel ? 'clips' : isSidecar ? 'carousel_container' : 'feed',
        display_url: `https://cdn.example/${owner}/${i}.jpg`,
        dimensions: { height: 1350, width: 1080 },
        accessibility_caption: i % 4 === 0 ? 'Photo of a mountain' : null,
        edge_media_to_caption: { edges: [{ node: { text: `Post ${i} by @${owner} #travel #nature${i % 2 ? ' #photography' : ''} with @friend.one` } }] },
        edge_media_preview_like: { count: opts.hideLikes ? -1 : likes },
        like_and_view_counts_disabled: Boolean(opts.hideLikes),
        edge_media_to_comment: { count: Math.floor(likes / 50) },
        video_view_count: isReel ? likes * 8 : undefined,
        video_play_count: isReel ? likes * 30 : undefined,
        video_duration: isReel ? 30 + i : undefined,
        video_url: isReel ? `https://cdn.example/${owner}/${i}.mp4` : undefined,
        taken_at_timestamp: NOW - (i * 2 + 1) * DAY - (i === 0 ? 400 * DAY : 0), // post 0 is an old pinned post
        pinned_for_users: i === 0 ? [{ id: u.id }] : [],
        owner: { id: u.id, username: owner, full_name: owner.replace(/_/g, ' '), is_verified: owner === 'natgeo' },
        location: i % 4 === 3 ? { id: '7538318', name: 'Copenhagen', slug: 'copenhagen' } : null,
        edge_sidecar_to_children: isSidecar ? { edges: [0, 1, 2].map((k) => ({ node: { id: `${id}${k}`, is_video: k === 2, display_url: `https://cdn.example/${owner}/${i}_${k}.jpg`, video_url: k === 2 ? 'https://cdn.example/v.mp4' : undefined } })) } : undefined,
        edge_media_to_tagged_user: { edges: i % 2 ? [{ node: { user: { username: 'tagged.person' } } }] : [] },
        coauthor_producers: i === 5 ? [{ username: 'collab_partner' }] : [],
        clips_music_attribution_info: isReel ? { artist_name: owner, song_name: 'Original audio', uses_original_audio: true, audio_id: `a${i}` } : undefined,
        is_paid_partnership: i === 4,
        comments_disabled: false,
    };
}

/** Same post in mobile/v1 shape. */
function v1Item(owner, i, opts) {
    const g = graphNode(owner, i, opts);
    return {
        pk: g.id, id: `${g.id}_${USERS[owner]?.id ?? 1}`, code: g.shortcode,
        media_type: g.edge_sidecar_to_children ? 8 : g.is_video ? 2 : 1, product_type: g.product_type,
        caption: { text: g.edge_media_to_caption.edges[0].node.text },
        like_count: g.edge_media_preview_like.count, like_and_view_counts_disabled: g.like_and_view_counts_disabled,
        comment_count: g.edge_media_to_comment.count, play_count: g.video_play_count, view_count: g.video_view_count, video_duration: g.video_duration,
        taken_at: g.taken_at_timestamp, user: { pk: g.owner.id, username: owner, full_name: g.owner.full_name, is_verified: g.owner.is_verified },
        image_versions2: { candidates: [{ url: g.display_url }] }, original_height: 1350, original_width: 1080,
        video_versions: g.video_url ? [{ url: g.video_url }] : undefined,
        carousel_media: g.edge_sidecar_to_children?.edges.map(({ node }) => ({ pk: node.id, media_type: node.is_video ? 2 : 1, image_versions2: { candidates: [{ url: node.display_url }] } })),
        usertags: { in: g.edge_media_to_tagged_user.edges.map((e) => ({ user: e.node.user })) },
        location: g.location ? { pk: g.location.id, name: g.location.name } : null,
        timeline_pinned_user_ids: g.pinned_for_users.length ? [Number(g.owner.id)] : [],
        clips_metadata: g.is_video ? { original_sound_info: { ig_artist: { username: owner }, original_audio_title: 'Original audio', audio_asset_id: 1 } } : undefined,
        comments_disabled: false,
    };
}

const COMMENTS_PER_POST = 40;
function graphComment(sc, k) {
    return {
        id: `179${hash(sc)}${String(k).padStart(3, '0')}`,
        text: k % 7 === 0 ? 'Amazing shot! 😍' : `comment ${k} on ${sc}`,
        created_at: NOW - k * 3600,
        owner: { id: `90${k}`, username: `fan_${k}`, profile_pic_url: `https://cdn.example/fan${k}.jpg`, is_verified: k === 3 },
        edge_liked_by: { count: k % 5 },
        edge_threaded_comments: { count: k % 10 === 1 ? 3 : 0, edges: k % 10 === 1 ? [{ node: { id: `r${k}a`, text: 'reply a', created_at: NOW - k * 3000, owner: { id: '1', username: 'replier' }, edge_liked_by: { count: 0 } } }] : [] },
    };
}
function v1Comment(sc, k) {
    const g = graphComment(sc, k);
    return { pk: g.id, text: g.text, created_at: g.created_at, user: { pk: g.owner.id, username: g.owner.username, profile_pic_url: g.owner.profile_pic_url, is_verified: g.owner.is_verified }, comment_like_count: g.edge_liked_by.count, child_comment_count: g.edge_threaded_comments.count };
}

function postOwner(sc) {
    const id = shortcodeToId(sc);
    for (const owner of Object.keys(USERS)) for (let i = 0; i < USERS[owner].posts; i++) if (mediaId(owner, i) === id) return { owner, i };
    return null;
}

/**
 * @param {object} cfg  blockRate: random block share; alwaysBlocked: names of methods that always 401; down: everything blocked
 */
export function startMock(cfg = {}) {
    const { blockRate = 0.1, alwaysBlocked = [], delayMs = 0 } = cfg;
    let seed = 99;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const hits = { total: 0, byPath: {} };
    const send = (res, status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const blocked = (res) => {
        const k = rand();
        if (k < 0.5) return send(res, 429, { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' });
        if (k < 0.8) return send(res, 401, { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' });
        return send(res, 302, '', { location: 'https://www.instagram.com/accounts/login/' });
    };

    const server = http.createServer(async (req, res) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const url = new URL(req.url, 'http://x');
        const path = url.pathname;
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        const q = url.searchParams;
        const method = (() => {
            if (path === '/api/v1/users/web_profile_info/') return 'web_profile_info';
            if (path.startsWith('/graphql/query')) {
                if (q.get('query_hash') === '69cba40317214236af40e7efa697781d') return 'graphql_timeline';
                if (q.get('query_hash') === 'be13233562af2d229b008d2976b998b5') return 'graphql_tagged';
                if (q.get('query_hash') === 'bc3296d1ce80a24b1b6e40b1e72903f5') return 'graphql_comments';
                if (q.get('query_hash')) return 'graphql_hash_post';
                return 'graphql_doc';
            }
            if (/^\/api\/v1\/feed\/user\/\d+\/$/.test(path)) return 'v1_feed_user';
            if (path === '/api/v1/clips/user/') return 'clips_user';
            if (/^\/api\/v1\/usertags\//.test(path)) return 'usertags';
            if (/\/child_comments\//.test(path)) return 'child_comments';
            if (/^\/api\/v1\/media\/\d+\/comments\/$/.test(path)) return 'v1_comments';
            if (/^\/api\/v1\/users\/\d+\/info\/$/.test(path)) return 'user_info';
            if (path === '/api/v1/tags/web_info/') return 'tags_web_info';
            if (/^\/api\/v1\/tags\/[^/]+\/sections\/$/.test(path)) return 'tag_sections';
            if (path === '/api/v1/locations/web_info/') return 'locations_web_info';
            if (/^\/api\/v1\/locations\/\d+\/sections\/$/.test(path)) return 'location_sections';
            if (path === '/web/search/topsearch/') return 'topsearch';
            if (path === '/html/') return 'ddg';
            if (path.startsWith('/share/')) return 'share';
            return 'other';
        })();
        hits.total += 1;
        hits.byPath[method] = (hits.byPath[method] ?? 0) + 1;
        if (method !== 'ddg' && !req.headers['x-ig-app-id'] && method !== 'share') return send(res, 400, { message: 'useragent mismatch', status: 'fail' });
        if (alwaysBlocked.includes(method) || (method !== 'ddg' && rand() < blockRate)) return blocked(res);

        switch (method) {
            case 'web_profile_info': {
                const name = q.get('username');
                const u = USERS[name];
                if (!u) return send(res, 200, { data: { user: null }, status: 'ok' });
                const edges = u.private ? [] : Array.from({ length: Math.min(12, u.posts) }, (_, i) => ({ node: graphNode(name, i, { hideLikes: name === 'nasawebb' && i === 2 }) }));
                return send(res, 200, { data: { user: {
                    id: u.id, username: name, full_name: name.replace(/_/g, ' '), biography: u.bio, external_url: u.biz ? 'https://brandco.com' : null,
                    bio_links: u.biz ? [{ title: 'Shop', url: 'https://brandco.com', link_type: 'external' }] : [],
                    edge_followed_by: { count: u.followers }, edge_follow: { count: 321 }, is_private: Boolean(u.private), is_verified: name === 'natgeo',
                    is_business_account: u.biz, is_professional_account: u.biz, business_email: u.email ?? null, category_name: u.biz ? 'Shopping & retail' : null,
                    highlight_reel_count: 4, has_clips: true, profile_pic_url: 'https://cdn.example/p.jpg', profile_pic_url_hd: 'https://cdn.example/p_hd.jpg', fbid: '1784',
                    edge_felix_video_timeline: { count: 0 },
                    edge_owner_to_timeline_media: { count: u.posts, edges, page_info: { has_next_page: !u.private && u.posts > 12, end_cursor: 'g12' } },
                    edge_related_profiles: { edges: [{ node: { username: 'related_one', full_name: 'Related One', is_verified: false } }] },
                } }, status: 'ok' });
            }
            case 'graphql_timeline': {
                const v = JSON.parse(q.get('variables'));
                const owner = ID_TO_USER[v.id];
                if (!owner) return send(res, 200, { data: { user: null } });
                const start = v.after ? Number(v.after.slice(1)) : 0;
                const n = USERS[owner].posts;
                const edges = Array.from({ length: Math.max(0, Math.min(v.first, n - start)) }, (_, k) => ({ node: graphNode(owner, start + k) }));
                return send(res, 200, { data: { user: { edge_owner_to_timeline_media: { count: n, edges, page_info: { has_next_page: start + v.first < n, end_cursor: `g${start + v.first}` } } } } });
            }
            case 'v1_feed_user': {
                const owner = ID_TO_USER[path.split('/')[5]];
                const n = USERS[owner].posts;
                const mx = q.get('max_id');
                let start = 0;
                if (/^\d+_\d+$/.test(mx ?? '')) start = Array.from({ length: n }, (_, i) => mediaId(owner, i)).indexOf(mx.split('_')[0]) + 1;
                else if (mx) start = Number(mx.slice(1));
                const items = Array.from({ length: Math.max(0, Math.min(12, n - start)) }, (_, k) => v1Item(owner, start + k));
                return send(res, 200, { items, more_available: start + 12 < n, next_max_id: items.length ? items[items.length - 1].id : null, status: 'ok' });
            }
            case 'clips_user': {
                const owner = ID_TO_USER[form.get('target_user_id')];
                const reels = Array.from({ length: USERS[owner].posts }, (_, i) => i).filter((i) => i % 3 === 1);
                const start = form.get('max_id') ? Number(form.get('max_id')) : 0;
                const items = reels.slice(start, start + 12).map((i) => ({ media: v1Item(owner, i) }));
                return send(res, 200, { items, paging_info: { more_available: start + 12 < reels.length, max_id: String(start + 12) }, status: 'ok' });
            }
            case 'graphql_tagged': {
                const v = JSON.parse(q.get('variables'));
                const edges = Array.from({ length: 5 }, (_, k) => {
                    const n = graphNode('brand_co', k + 20);
                    n.edge_media_to_tagged_user = { edges: [{ node: { user: { username: ID_TO_USER[v.id] } } }] };
                    return { node: n };
                });
                return send(res, 200, { data: { user: { edge_user_to_photos_of_you: { count: 5, edges, page_info: { has_next_page: false, end_cursor: null } } } } });
            }
            case 'graphql_doc': {
                const v = JSON.parse(form.get('variables') ?? q.get('variables') ?? '{}');
                const found = postOwner(v.shortcode);
                if (!found) return send(res, 200, { data: { xdt_shortcode_media: null }, status: 'ok' });
                const node = graphNode(found.owner, found.i);
                node.edge_media_to_parent_comment = { count: COMMENTS_PER_POST, edges: Array.from({ length: 15 }, (_, k) => ({ node: graphComment(v.shortcode, k) })), page_info: { has_next_page: true, end_cursor: 'c15' } };
                return send(res, 200, { data: { xdt_shortcode_media: node }, status: 'ok' });
            }
            case 'v1_comments': {
                const sc = idToShortcode(path.split('/')[4]);
                const start = q.get('min_id') ? Number(q.get('min_id').slice(1)) : 0;
                const order = q.get('sort_order') === 'newest' ? (k) => k : (k) => k;
                const comments = Array.from({ length: Math.max(0, Math.min(15, COMMENTS_PER_POST - start)) }, (_, k) => v1Comment(sc, order(start + k)));
                return send(res, 200, { comments, next_min_id: `c${start + 15}`, has_more_headload_comments: start + 15 < COMMENTS_PER_POST, status: 'ok' });
            }
            case 'graphql_comments': {
                const v = JSON.parse(q.get('variables'));
                const start = v.after ? Number(v.after.slice(1)) : 0;
                const edges = Array.from({ length: Math.max(0, Math.min(15, COMMENTS_PER_POST - start)) }, (_, k) => ({ node: graphComment(v.shortcode, start + k) }));
                return send(res, 200, { data: { shortcode_media: { edge_media_to_parent_comment: { edges, page_info: { has_next_page: start + 15 < COMMENTS_PER_POST, end_cursor: `c${start + 15}` } } } } });
            }
            case 'child_comments': {
                const parent = path.split('/')[6];
                return send(res, 200, { child_comments: [1, 2].map((k) => ({ pk: `${parent}r${k}`, text: `reply ${k}`, created_at: NOW - 100, user: { pk: '2', username: 'replier2' }, comment_like_count: 0 })), has_more_tail_child_comments: false, status: 'ok' });
            }
            case 'user_info': {
                const owner = ID_TO_USER[path.split('/')[4]];
                if (!owner) return send(res, 404, { message: 'User not found', status: 'fail' });
                return send(res, 200, { user: { pk: USERS[owner].id, username: owner }, status: 'ok' });
            }
            case 'tags_web_info': {
                const tag = q.get('tag_name');
                if (tag === 'nonexistenttag12345') return send(res, 404, { message: 'not found', status: 'fail' });
                const top = { sections: [{ layout_content: { medias: [0, 1, 2].map((i) => ({ media: v1Item('natgeo', i + 1) })) } }] };
                const recent = { sections: [{ layout_content: { medias: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => ({ media: v1Item('nasawebb', i) })) } }], more_available: true, next_max_id: 'r1', next_page: 1 };
                return send(res, 200, { data: { id: '17843', name: tag, media_count: 21310000, profile_pic_url: 'https://cdn.example/tag.jpg', top, recent }, status: 'ok' });
            }
            case 'tag_sections':
            case 'location_sections': {
                const page = Number(form.get('page') ?? 1);
                const medias = Array.from({ length: 6 }, (_, k) => ({ media: v1Item('nasawebb', 14 + page * 6 + k) })).filter((m) => m.media.code);
                return send(res, 200, { sections: [{ layout_content: { medias } }], more_available: page < 3, next_max_id: `r${page + 1}`, next_page: page + 1, status: 'ok' });
            }
            case 'locations_web_info': {
                const id = q.get('location_id');
                return send(res, 200, { native_location_data: {
                    location_info: { location_id: id, name: 'Lucerna Music Bar', phone: '+420 224 217 108', category: 'Live Music Venue', media_count: 41997, price_range: 0, lat: 50.0811, lng: 14.4256, location_address: 'Vodičkova 36', location_city: 'Prague', location_zip: '110 00', ig_business: { profile: { username: 'lucernamusicbar' } }, hours: { status: 'Open now' } },
                    ranked: { sections: [{ layout_content: { medias: [{ media: v1Item('natgeo', 3) }] } }] },
                    recent: { sections: [{ layout_content: { medias: [5, 6, 7].map((i) => ({ media: v1Item('natgeo', i) })) } }], more_available: false },
                }, status: 'ok' });
            }
            case 'topsearch':
                return blocked(res); // logged-out search is login-walled -> forces the DuckDuckGo fallback
            case 'ddg': {
                const qq = q.get('q');
                const links = qq.includes('explore/tags') ? ['https://www.instagram.com/explore/tags/vintagefashion/', 'https://www.instagram.com/explore/tags/vintageshop/']
                    : qq.includes('explore/locations') ? ['https://www.instagram.com/explore/locations/218622660/lucerna-music-bar/']
                        : ['https://www.instagram.com/natgeo/', 'https://www.instagram.com/brand_co/', 'https://www.instagram.com/p/ABC123xyz/'];
                return send(res, 200, `<div class="results">${links.map((l) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(l)}&rut=x">r</a>`).join('')}</div>`);
            }
            case 'share':
                return send(res, 302, '', { location: `https://www.instagram.com/p/${idToShortcode(mediaId('natgeo', 4))}/` });
            default:
                return send(res, 404, { message: 'not found' });
        }
    });

    const proxy = http.createServer((req, res) => {
        const target = new URL(req.url);
        const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        up.on('error', () => res.writeHead(502).end());
        req.pipe(up);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', () => resolve({
            base: `http://127.0.0.1:${server.address().port}`, proxyUrl: `http://127.0.0.1:${proxy.address().port}`, hits,
            shortcode: (owner, i) => idToShortcode(mediaId(owner, i)), mediaId,
            close: () => { server.close(); proxy.close(); },
        })));
    });
}
