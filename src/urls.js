// Input parsing: every Instagram URL form (and plain handles / #tags / numeric IDs) -> a typed target.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer', 'legal', 'web', 'graphql',
    'api', 's', 'challenge', 'privacy', 'emails', 'session', 'share', 'help', 'press', 'blog', 'jobs', 'nametag', 'oauth', 'static', 'ar', 'lite']);

/** Shortcode -> numeric media ID (as string). Long (private-post) shortcodes use their first 11 characters. */
export function shortcodeToId(shortcode) {
    let id = 0n;
    for (const ch of shortcode.slice(0, 11)) {
        const v = ALPHABET.indexOf(ch);
        if (v < 0) return null;
        id = id * 64n + BigInt(v);
    }
    return id.toString();
}

/** Numeric media ID ("3923124318436838545" or "3923124318436838545_787132") -> shortcode. */
export function idToShortcode(id) {
    let n;
    try {
        n = BigInt(String(id).split('_')[0]);
    } catch {
        return null;
    }
    if (n <= 0n) return null;
    let out = '';
    while (n > 0n) {
        out = ALPHABET[Number(n % 64n)] + out;
        n /= 64n;
    }
    return out;
}

const USER_RE = /^[a-z0-9._]{1,30}$/i;

/**
 * @returns {{kind:'profile'|'profileId'|'post'|'hashtag'|'location'|'share', value:string, inputUrl:string, hint?:string} | {invalid:true, inputUrl:string, error:string}}
 */
export function parseTarget(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return null;
    const bad = (error) => ({ invalid: true, inputUrl: input, error });

    if (/^#[\p{L}\p{N}_]+$/u.test(input)) return { kind: 'hashtag', value: input.slice(1).toLowerCase(), inputUrl: input };
    if (/^@?[a-z0-9._]{1,30}$/i.test(input) && !/^\d+$/.test(input)) return { kind: 'profile', value: input.replace(/^@/, '').toLowerCase(), inputUrl: input };
    if (/^\d{3,20}$/.test(input)) return { kind: 'profileId', value: input, inputUrl: input };

    let url;
    try {
        url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return bad('not a valid Instagram URL, username or #hashtag');
    }
    const host = url.hostname.toLowerCase().replace(/^(?:www|m|l)\./, '');
    if (host === 'instagr.am') url.hostname = 'instagram.com';
    else if (host !== 'instagram.com') return bad('not an instagram.com URL');

    let seg = url.pathname.split('/').filter(Boolean).map((s) => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    });
    if (seg[0] === '_u') seg = seg.slice(1);
    seg = seg.filter((s) => s.toLowerCase() !== 'profilecard');
    if (!seg.length) return bad('Instagram home page — add a profile, post, hashtag or place URL');
    const first = seg[0].toLowerCase();

    if (['p', 'reel', 'reels', 'tv'].includes(first) && seg[1]) {
        if (first === 'reels' && seg[1].toLowerCase() === 'audio') return bad('audio pages are not supported — use the reel or profile URL');
        let code = seg[1];
        if (/^\d{10,25}$/.test(code)) code = idToShortcode(code);
        if (!code || !/^[A-Za-z0-9_-]{5,}$/.test(code)) return bad('could not read the post code from this URL');
        return { kind: 'post', value: code, inputUrl: input, hint: first === 'p' ? 'post' : 'reel' };
    }
    if (first === 'explore' && seg[1] === 'tags' && seg[2]) return { kind: 'hashtag', value: seg[2].replace(/^#/, '').toLowerCase(), inputUrl: input };
    if (first === 'explore' && seg[1] === 'locations' && /^\d+$/.test(seg[2] ?? '')) return { kind: 'location', value: seg[2], inputUrl: input, hint: seg[3] ?? null };
    if (first === 'stories' && seg[1]) {
        if (seg[1] === 'highlights') return bad('story highlights are not supported — use the profile URL');
        return USER_RE.test(seg[1]) ? { kind: 'profile', value: seg[1].toLowerCase(), inputUrl: input } : bad('could not read the username');
    }
    if (first === 'share' || first === 's') return { kind: 'share', value: url.href, inputUrl: input };
    if (RESERVED.has(first)) return bad(`instagram.com/${first}/ pages are not supported`);

    // profile, profile/reels, profile/tagged, profile/p/CODE
    if (seg[1] && ['p', 'reel', 'tv'].includes(seg[1].toLowerCase()) && seg[2]) return parseTarget(`https://www.instagram.com/${seg[1]}/${seg[2]}/`);
    if (/^\d{3,20}$/.test(seg[0])) return { kind: 'profileId', value: seg[0], inputUrl: input };
    if (!USER_RE.test(seg[0])) return bad('could not read the username from this URL');
    const section = seg[1]?.toLowerCase();
    return { kind: 'profile', value: seg[0].toLowerCase(), inputUrl: input, hint: section === 'reels' ? 'reels' : section === 'tagged' ? 'tagged' : null };
}

/** Parses "1 day", "2 weeks", "3 months", "2024-09-05", "2024-09-05T13:22:04Z" -> Date (UTC). null when empty. */
export function parseNewerThan(value, now = Date.now()) {
    const v = String(value ?? '').trim();
    if (!v) return null;
    const rel = v.match(/^(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day|week|month|year)s?$/i);
    if (rel) {
        const n = Number(rel[1]);
        const unit = rel[2].toLowerCase();
        const ms = { minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[unit];
        return new Date(now - n * ms);
    }
    const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(v)
        ? (/(?:Z|[+-]\d{2}:?\d{2})$/.test(v) || v.length === 10 ? v : `${v}Z`) : null;
    if (!iso) throw new Error(`"${v}" is not a valid date. Use "3 days", "2 weeks", "2024-09-05" or "2024-09-05T13:22:04Z".`);
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new Error(`"${v}" is not a valid date.`);
    return d;
}
