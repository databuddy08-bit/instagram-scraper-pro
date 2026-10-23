// Normalizers: Instagram's GraphQL ("edge") shapes and mobile/v1 API ("items") shapes -> one clean output format.
// Field names follow the widely used Apify Instagram Scraper format; values Instagram doesn't expose stay null (never guessed).
import { extractEmails, extractPhones, phonesFromUrl, emailsFromUrl, isUsableEmail, phoneKey } from './contacts.js';
import { idToShortcode } from './urls.js';

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
const MENTION_RE = /(?:^|[^\w.@])@([a-z0-9._]{1,30})/gi;
const iso = (sec) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const uniq = (a) => [...new Set(a)];
export const postUrl = (sc) => `https://www.instagram.com/p/${sc}/`;

export function captionTags(text) {
    const t = String(text ?? '');
    return {
        hashtags: uniq([...t.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase())),
        mentions: uniq([...t.matchAll(MENTION_RE)].map((m) => m[1].replace(/\.+$/, '').toLowerCase())).filter(Boolean),
    };
}

// ---------- Comments ----------

export function commentFromGraph(node, sc, parentId = null) {
    if (!node?.id) return null;
    const o = node.owner ?? {};
    return {
        postUrl: postUrl(sc),
        commentUrl: `${postUrl(sc)}c/${node.id}`,
        id: String(node.id),
        text: node.text ?? '',
        ownerUsername: o.username ?? null,
        ownerId: o.id ? String(o.id) : null,
        ownerProfilePicUrl: o.profile_pic_url ?? null,
        ownerIsVerified: typeof o.is_verified === 'boolean' ? o.is_verified : null,
        timestamp: iso(node.created_at),
        likesCount: num(node.edge_liked_by?.count),
        repliesCount: num(node.edge_threaded_comments?.count),
        parentCommentId: parentId,
        isReply: Boolean(parentId),
    };
}

export function commentFromV1(c, sc, parentId = null) {
    const id = c?.pk ?? c?.id;
    if (!id) return null;
    const u = c.user ?? {};
    return {
        postUrl: postUrl(sc),
        commentUrl: `${postUrl(sc)}c/${id}`,
        id: String(id),
        text: c.text ?? '',
        ownerUsername: u.username ?? null,
        ownerId: u.pk ? String(u.pk) : (u.id ? String(u.id) : null),
        ownerProfilePicUrl: u.profile_pic_url ?? null,
        ownerIsVerified: typeof u.is_verified === 'boolean' ? u.is_verified : null,
        timestamp: iso(c.created_at_utc ?? c.created_at),
        likesCount: num(c.comment_like_count),
        repliesCount: num(c.child_comment_count),
        parentCommentId: parentId ?? (c.parent_comment_id ? String(c.parent_comment_id) : null),
        isReply: Boolean(parentId ?? c.parent_comment_id),
    };
}

const shortComment = (c) => (c ? { id: c.id, text: c.text, ownerUsername: c.ownerUsername, timestamp: c.timestamp, likesCount: c.likesCount } : null);

// ---------- Posts / reels ----------

function finishPost(p) {
    const tags = captionTags(p.caption);
    p.hashtags = tags.hashtags;
    p.mentions = tags.mentions;
    p.url = p.shortCode ? postUrl(p.shortCode) : null;
    p.isReel = p.productType === 'clips';
    return p;
}

export function postFromGraph(n) {
    if (!n || (!n.shortcode && !n.id)) return null;
    const sc = n.shortcode ?? idToShortcode(n.id);
    const tn = String(n.__typename ?? '');
    const isSidecar = /Sidecar/.test(tn) || Boolean(n.edge_sidecar_to_children);
    const likesRaw = n.edge_media_preview_like?.count ?? n.edge_liked_by?.count;
    const likesHidden = Boolean(n.like_and_view_counts_disabled) || likesRaw === -1;
    const commentsConn = n.edge_media_to_parent_comment ?? n.edge_media_preview_comment ?? n.edge_media_to_comment;
    const comments = (commentsConn?.edges ?? []).map((e) => commentFromGraph(e.node, sc)).filter(Boolean);
    const children = (n.edge_sidecar_to_children?.edges ?? []).map(({ node: c }) => ({
        id: c.id ? String(c.id) : null,
        type: c.is_video ? 'Video' : 'Image',
        displayUrl: c.display_url ?? null,
        videoUrl: c.video_url ?? null,
        alt: c.accessibility_caption ?? null,
        dimensionsHeight: c.dimensions?.height ?? null,
        dimensionsWidth: c.dimensions?.width ?? null,
    }));
    const owner = n.owner ?? {};
    const music = n.clips_music_attribution_info;
    return finishPost({
        id: n.id ? String(n.id) : null,
        type: isSidecar ? 'Sidecar' : n.is_video ? 'Video' : 'Image',
        shortCode: sc,
        caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
        commentsCount: num(commentsConn?.count ?? n.edge_media_to_comment?.count),
        firstComment: comments[0]?.text ?? null,
        latestComments: comments.slice(0, 15).map(shortComment),
        dimensionsHeight: n.dimensions?.height ?? null,
        dimensionsWidth: n.dimensions?.width ?? null,
        displayUrl: n.display_url ?? n.thumbnail_src ?? null,
        images: isSidecar ? children.filter((c) => c.type === 'Image').map((c) => c.displayUrl) : [],
        videoUrl: n.video_url ?? null,
        alt: n.accessibility_caption ?? null,
        likesCount: likesHidden ? null : num(likesRaw),
        likesHidden,
        videoViewCount: num(n.video_view_count),
        videoPlayCount: num(n.video_play_count),
        videoDuration: num(n.video_duration),
        timestamp: iso(n.taken_at_timestamp),
        childPosts: children,
        ownerFullName: owner.full_name ?? null,
        ownerUsername: owner.username ?? null,
        ownerId: owner.id ? String(owner.id) : null,
        ownerIsVerified: typeof owner.is_verified === 'boolean' ? owner.is_verified : null,
        productType: n.product_type ?? (n.is_video ? 'igtv' : 'feed'),
        isPinned: Array.isArray(n.pinned_for_users) ? n.pinned_for_users.length > 0 : null,
        isCommentsDisabled: typeof n.comments_disabled === 'boolean' ? n.comments_disabled : null,
        isSponsored: typeof n.is_paid_partnership === 'boolean' ? n.is_paid_partnership : null,
        taggedUsers: (n.edge_media_to_tagged_user?.edges ?? []).map((e) => e.node?.user?.username).filter(Boolean),
        coauthorProducers: (n.coauthor_producers ?? []).map((u) => u.username).filter(Boolean),
        locationName: n.location?.name ?? null,
        locationId: n.location?.id ? String(n.location.id) : null,
        musicInfo: music ? { artist_name: music.artist_name ?? null, song_name: music.song_name ?? null, uses_original_audio: music.uses_original_audio ?? null, audio_id: music.audio_id ?? null } : null,
    });
}

function v1Image(item) {
    return item?.image_versions2?.candidates?.[0]?.url ?? null;
}

export function postFromV1(item) {
    const m = item?.media ?? item;
    if (!m || (!m.code && !m.pk && !m.id)) return null;
    const id = String(m.pk ?? String(m.id).split('_')[0]);
    const sc = m.code ?? idToShortcode(id);
    const likesHidden = Boolean(m.like_and_view_counts_disabled) || m.like_count === -1;
    const carousel = (m.carousel_media ?? []).map((c) => ({
        id: c.pk ? String(c.pk) : null,
        type: c.media_type === 2 ? 'Video' : 'Image',
        displayUrl: v1Image(c),
        videoUrl: c.video_versions?.[0]?.url ?? null,
        alt: c.accessibility_caption ?? null,
        dimensionsHeight: c.original_height ?? null,
        dimensionsWidth: c.original_width ?? null,
    }));
    const comments = (m.preview_comments ?? m.comments ?? []).map((c) => commentFromV1(c, sc)).filter(Boolean);
    const u = m.user ?? m.owner ?? {};
    const musicAsset = m.clips_metadata?.music_info?.music_asset_info ?? m.music_metadata?.music_info?.music_asset_info;
    const orig = m.clips_metadata?.original_sound_info ?? m.music_metadata?.original_sound_info;
    const music = musicAsset
        ? { artist_name: musicAsset.display_artist ?? null, song_name: musicAsset.title ?? null, uses_original_audio: false, audio_id: musicAsset.audio_asset_id ? String(musicAsset.audio_asset_id) : null }
        : orig ? { artist_name: orig.ig_artist?.username ?? null, song_name: orig.original_audio_title ?? null, uses_original_audio: true, audio_id: orig.audio_asset_id ? String(orig.audio_asset_id) : null } : null;
    // Pinned only when pinned by this post's owner (co-authors can pin a shared post on their own profile).
    const ownerPk = String((m.user ?? m.owner ?? {}).pk ?? (m.user ?? m.owner ?? {}).id ?? '');
    const pinnedBy = [...(m.timeline_pinned_user_ids ?? []), ...(m.clips_tab_pinned_user_ids ?? [])].map(String);
    const pinned = ownerPk ? pinnedBy.includes(ownerPk) : pinnedBy.length > 0;
    const loc = m.location ?? (Array.isArray(m.locations) ? m.locations[0] : null);
    return finishPost({
        id,
        type: m.media_type === 8 ? 'Sidecar' : m.media_type === 2 ? 'Video' : 'Image',
        shortCode: sc,
        caption: m.caption?.text ?? '',
        commentsCount: num(m.comment_count),
        firstComment: comments[0]?.text ?? null,
        latestComments: comments.slice(0, 15).map(shortComment),
        dimensionsHeight: m.original_height ?? null,
        dimensionsWidth: m.original_width ?? null,
        displayUrl: v1Image(m) ?? v1Image(m.carousel_media?.[0]) ?? m.display_uri ?? null,
        images: carousel.filter((c) => c.type === 'Image').map((c) => c.displayUrl),
        videoUrl: m.video_versions?.[0]?.url ?? null,
        alt: m.accessibility_caption ?? null,
        likesCount: likesHidden ? null : num(m.like_count),
        likesHidden,
        videoViewCount: num(m.view_count),
        videoPlayCount: num(m.play_count ?? m.ig_play_count),
        videoDuration: num(m.video_duration),
        timestamp: iso(m.taken_at),
        childPosts: carousel,
        ownerFullName: u.full_name ?? null,
        ownerUsername: u.username ?? null,
        ownerId: u.pk ? String(u.pk) : (u.id ? String(u.id) : null),
        ownerIsVerified: typeof u.is_verified === 'boolean' ? u.is_verified : null,
        productType: m.product_type ?? null,
        isPinned: pinned,
        isCommentsDisabled: typeof m.comments_disabled === 'boolean' ? m.comments_disabled : null,
        isSponsored: typeof m.is_paid_partnership === 'boolean' ? m.is_paid_partnership : null,
        taggedUsers: (m.usertags?.in ?? []).map((t) => t.user?.username).filter(Boolean),
        coauthorProducers: (m.coauthor_producers ?? []).map((x) => x.username).filter((x) => x && x !== u.username),
        locationName: loc?.name ?? null,
        locationId: loc?.pk ? String(loc.pk) : (loc?.id ? String(loc.id) : null),
        musicInfo: music,
    });
}

/** Accepts either shape. */
export function normalizePost(x) {
    if (!x) return null;
    if (x.shortcode || x.__typename || x.edge_media_to_caption || x.taken_at_timestamp) return postFromGraph(x);
    return postFromV1(x);
}

/** Walks any v1 "sections" tree and returns every media object inside it (top/recent grids, clips rows…). */
export function mediaFromTree(tree) {
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 12) return;
        if (Array.isArray(o)) {
            o.forEach((x) => walk(x, depth + 1));
            return;
        }
        if (o.code && (o.pk || o.id) && o.media_type !== undefined) {
            if (!seen.has(o.code)) {
                seen.add(o.code);
                out.push(o);
            }
            return;
        }
        for (const v of Object.values(o)) walk(v, depth + 1);
    };
    walk(tree, 0);
    return out;
}

// ---------- Profiles ----------

/**
 * @param u raw profile (web_profile_info GraphQL user, mobile user info, or the minimal user from the posts feed)
 * @param o.posts already-normalized latest posts (used when posts came from the feed instead of the profile)
 */
export function profileFromUser(u, { latestPostsLimit = 12, posts: givenPosts = null } = {}) {
    if (!u) return null;
    const isGraph = 'edge_followed_by' in u || 'edge_owner_to_timeline_media' in u;
    const bioLinks = (u.bio_links ?? []).map((l) => ({ title: l.title ?? '', url: l.url ?? l.lynx_url ?? null, link_type: l.link_type ?? 'external' })).filter((l) => l.url);
    const followers = isGraph ? num(u.edge_followed_by?.count) : num(u.follower_count);
    const posts = givenPosts ?? (isGraph ? (u.edge_owner_to_timeline_media?.edges ?? []).map((e) => postFromGraph(e.node)).filter(Boolean) : []);
    const bio = u.biography ?? '';

    // contacts with evidence (bio text, link URLs, business contact buttons)
    const evidence = [];
    const emails = extractEmails(bio, 'bio');
    const phones = extractPhones(bio, 'bio');
    for (const l of [u.external_url, ...bioLinks.map((x) => x.url)]) {
        for (const e of emailsFromUrl(l, 'bio link')) if (!emails.some((x) => x.value === e.value)) emails.push(e);
        for (const p of phonesFromUrl(l, 'bio link')) if (!phones.some((x) => phoneKey(x.value) === phoneKey(p.value))) phones.push(p);
    }
    emails.forEach((e) => evidence.push(`${e.value} ← ${e.evidence}`));
    phones.forEach((p) => evidence.push(`${p.value} ← ${p.evidence}`));
    const bizEmailRaw = String(u.business_email ?? u.public_email ?? '').trim().toLowerCase();
    const businessEmail = bizEmailRaw && isUsableEmail(bizEmailRaw) ? bizEmailRaw : null;
    let businessPhone = u.business_phone_number ?? u.contact_phone_number ?? null;
    if (!businessPhone && u.public_phone_number) businessPhone = `${u.public_phone_country_code ? `+${u.public_phone_country_code}` : ''}${u.public_phone_number}`;
    if (businessEmail) evidence.push(`${businessEmail} ← Instagram business contact (email button)`);
    if (businessPhone) evidence.push(`${businessPhone} ← Instagram business contact (call button)`);

    let address = null;
    try {
        const a = typeof u.business_address_json === 'string' ? JSON.parse(u.business_address_json) : u.business_address_json;
        if (a) address = [a.street_address, a.city_name, a.region_name, a.zip_code, a.country_code].filter((x) => x && String(x).trim()).join(', ') || null;
    } catch { /* ignore */ }
    if (!address && (u.address_street || u.city_name)) address = [u.address_street, u.city_name, u.zip].filter(Boolean).join(', ') || null;

    // engagement from latest non-pinned posts with visible likes
    const pool = posts.filter((p) => !p.isPinned && p.likesCount !== null);
    const avgLikes = pool.length ? pool.reduce((s, p) => s + p.likesCount, 0) / pool.length : null;
    const avgComments = pool.length ? pool.reduce((s, p) => s + (p.commentsCount ?? 0), 0) / pool.length : null;
    const dated = posts.filter((p) => p.timestamp && !p.isPinned).map((p) => Date.parse(p.timestamp)).sort((a, b) => b - a);

    return {
        id: String(u.id ?? u.pk ?? ''),
        username: u.username,
        url: `https://www.instagram.com/${u.username}`,
        fullName: u.full_name ?? null,
        biography: bio || null,
        externalUrls: bioLinks,
        externalUrl: u.external_url ?? bioLinks[0]?.url ?? null,
        followersCount: followers,
        followsCount: isGraph ? num(u.edge_follow?.count) : num(u.following_count),
        postsCount: isGraph ? num(u.edge_owner_to_timeline_media?.count) : num(u.media_count),
        highlightReelCount: num(u.highlight_reel_count),
        igtvVideoCount: isGraph ? num(u.edge_felix_video_timeline?.count) : num(u.total_igtv_videos),
        isBusinessAccount: Boolean(u.is_business_account ?? u.is_business),
        isProfessionalAccount: typeof u.is_professional_account === 'boolean' ? u.is_professional_account : null,
        businessCategoryName: u.business_category_name ?? null,
        category: u.category_name ?? u.category ?? null,
        joinedRecently: typeof u.is_joined_recently === 'boolean' ? u.is_joined_recently : null,
        private: Boolean(u.is_private),
        verified: Boolean(u.is_verified),
        hasReels: typeof u.has_clips === 'boolean' ? u.has_clips : null,
        pronouns: Array.isArray(u.pronouns) ? u.pronouns : [],
        profilePicUrl: u.profile_pic_url ?? null,
        profilePicUrlHD: u.profile_pic_url_hd ?? u.hd_profile_pic_url_info?.url ?? u.profile_pic_url ?? null,
        fbid: u.fbid ? String(u.fbid) : null,
        businessEmail,
        businessPhone,
        businessAddress: address,
        emailsFromBio: emails.map((e) => e.value),
        phonesFromBio: phones.map((p) => p.value),
        contactEvidence: evidence,
        avgLikes: avgLikes === null ? null : Math.round(avgLikes),
        avgComments: avgComments === null ? null : Math.round(avgComments),
        engagementRate: avgLikes !== null && followers ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100 : null,
        engagementBasis: pool.length ? `last ${pool.length} non-pinned posts` : (u.is_private ? 'private account' : 'no posts with visible likes'),
        lastPostAt: dated.length ? new Date(dated[0]).toISOString() : null,
        relatedProfiles: (u.edge_related_profiles?.edges ?? []).map(({ node: r }) => ({ username: r.username, fullName: r.full_name ?? null, verified: Boolean(r.is_verified), private: Boolean(r.is_private) })),
        latestPosts: posts.slice(0, latestPostsLimit),
    };
}

// ---------- Hashtags ----------

/** Related hashtags measured from the hashtag's own posts (not a third-party estimate). */
export function relatedFromPosts(tag, posts) {
    const counts = {};
    for (const p of posts) for (const h of p.hashtags) if (h !== tag) counts[h] = (counts[h] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([h, n]) => ({ hash: `#${h}`, postsInSample: n, sharePct: Math.round((n / posts.length) * 1000) / 10 }));
}

export function postsPerDayFromPosts(posts) {
    const ts = posts.filter((p) => p.timestamp && !p.isPinned).map((p) => Date.parse(p.timestamp)).sort((a, b) => b - a);
    if (ts.length < 10) return { value: null, basis: `only ${ts.length} recent posts with dates — not enough to estimate` };
    const days = (ts[0] - ts[ts.length - 1]) / 864e5;
    if (days <= 0) return { value: null, basis: 'recent posts have identical timestamps' };
    return { value: Math.round(((ts.length - 1) / days) * 10) / 10, basis: `${ts.length} most recent posts spanning ${Math.round(days * 10) / 10} days` };
}

export function hashtagFromJson(json, tag) {
    const h = json?.data?.hashtag ?? json?.data ?? json?.graphql?.hashtag ?? json?.hashtag ?? json;
    if (!h || (h.media_count === undefined && !h.edge_hashtag_to_media && h.name === undefined)) return null;
    const graphPosts = [...(h.edge_hashtag_to_top_posts?.edges ?? []), ...(h.edge_hashtag_to_media?.edges ?? [])].map((e) => postFromGraph(e.node));
    const top = h.top ? mediaFromTree(h.top).map(postFromV1) : [];
    const recent = h.recent ? mediaFromTree(h.recent).map(postFromV1) : [];
    return {
        name: String(h.name ?? tag).toLowerCase(),
        id: h.id ? String(h.id) : null,
        postsCount: num(h.media_count ?? h.edge_hashtag_to_media?.count),
        profilePicUrl: h.profile_pic_url ?? null,
        topPosts: [...top, ...graphPosts.slice(0, 9)].filter(Boolean),
        recentPosts: [...recent, ...graphPosts.slice(9)].filter(Boolean),
        nextCursor: h.recent?.next_max_id ?? h.next_max_id ?? h.edge_hashtag_to_media?.page_info?.end_cursor ?? null,
        nextPage: h.recent?.next_page ?? h.next_page ?? null,
        moreAvailable: Boolean(h.recent?.more_available ?? h.more_available ?? h.edge_hashtag_to_media?.page_info?.has_next_page),
    };
}

// ---------- Places ----------

export function placeFromJson(json) {
    const info = json?.native_location_data?.location_info ?? json?.location_info ?? json?.data?.location_info;
    if (info) {
        return {
            locationId: String(info.location_id ?? info.pk ?? ''),
            name: info.name ?? null,
            category: info.category ?? null,
            phone: info.phone || null,
            website: info.website || null,
            priceRange: num(info.price_range),
            lat: info.lat ?? null,
            lng: info.lng ?? null,
            address: info.location_address || null,
            city: info.location_city || null,
            zip: info.location_zip || null,
            postsCount: num(info.media_count),
            igBusinessUsername: info.ig_business?.profile?.username ?? null,
            hoursStatus: info.hours?.status || null,
            topPosts: mediaFromTree(json?.native_location_data?.ranked ?? json?.ranked).map(postFromV1).filter(Boolean),
            recentPosts: mediaFromTree(json?.native_location_data?.recent ?? json?.recent).map(postFromV1).filter(Boolean),
            nextCursor: json?.native_location_data?.recent?.next_max_id ?? null,
            nextPage: json?.native_location_data?.recent?.next_page ?? null,
            moreAvailable: Boolean(json?.native_location_data?.recent?.more_available),
        };
    }
    const g = json?.graphql?.location ?? json?.location;
    if (g && (g.name || g.id)) {
        let a = {};
        try {
            a = typeof g.address_json === 'string' ? JSON.parse(g.address_json) : (g.address_json ?? {});
        } catch { /* ignore */ }
        return {
            locationId: String(g.id ?? ''),
            name: g.name ?? null,
            category: null,
            phone: g.phone || null,
            website: g.website || null,
            priceRange: null,
            lat: g.lat ?? null,
            lng: g.lng ?? null,
            address: a.street_address || null,
            city: a.city_name || null,
            zip: a.zip_code || null,
            postsCount: num(g.edge_location_to_media?.count),
            igBusinessUsername: null,
            hoursStatus: null,
            topPosts: (g.edge_location_to_top_posts?.edges ?? []).map((e) => postFromGraph(e.node)).filter(Boolean),
            recentPosts: (g.edge_location_to_media?.edges ?? []).map((e) => postFromGraph(e.node)).filter(Boolean),
            nextCursor: g.edge_location_to_media?.page_info?.end_cursor ?? null,
            nextPage: null,
            moreAvailable: Boolean(g.edge_location_to_media?.page_info?.has_next_page),
        };
    }
    return null;
}

/** Last resort: the public location page's meta tags. */
export function placeFromHtml(html, id) {
    const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1]
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
    const title = meta('og:title');
    if (!title) return null;
    const lat = Number(meta('place:location:latitude'));
    const lng = Number(meta('place:location:longitude'));
    const desc = meta('og:description') ?? '';
    const count = desc.match(/([\d.,]+[KMB]?)\s+(?:posts|Posts)/);
    return {
        locationId: String(id), name: title.replace(/\s*[•|·-]\s*Instagram.*$/i, '').replace(/^Instagram photos and videos at\s*/i, '').trim(), category: null,
        phone: null, website: null, priceRange: null, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, address: null, city: null,
        zip: null, postsCount: null, postsCountText: count?.[1] ?? null, igBusinessUsername: null, hoursStatus: null, topPosts: [], recentPosts: [],
        nextCursor: null, nextPage: null, moreAvailable: false, dataCompleteness: 'partial (page meta tags only)',
    };
}
