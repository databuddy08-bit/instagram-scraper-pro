// Email and phone extraction. Every value carries the exact source phrase as evidence.
// Rule: never guess. A number is only a phone when it is clearly written as one.

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;
const EMAIL_FULL_RE = new RegExp(`^${EMAIL_RE.source}$`, 'i');

// "name [at] brand [dot] com", "name (at) brand.com", "name at brand dot com"
const AT_BRACKET = String.raw`\s*[\[({<]\s*at\s*[\])}>]\s*`;
const DOT_ANY = String.raw`(?:\s*[\[({<]\s*dot\s*[\])}>]\s*|\s+dot\s+|\.)`;
const OBF_BRACKET_RE = new RegExp(String.raw`([a-z0-9][a-z0-9._%+-]{0,63})${AT_BRACKET}([a-z0-9-]+(?:${DOT_ANY}[a-z0-9-]+)+)`, 'gi');
const OBF_WORDS_RE = /([a-z0-9][a-z0-9._%+-]{0,63})\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)/gi;

const JUNK_EMAIL_DOMAINS = [
    'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'email.com', 'sentry.io', 'wixpress.com',
    'sentry-next.wixpress.com', 'sentry.wixpress.com', 'mysite.com', 'test.com',
];
// Contact addresses of link-in-bio platforms themselves (not the profile owner).
const PLATFORM_DOMAINS = [
    'linktr.ee', 'linktree.com', 'beacons.ai', 'stan.store', 'bento.me', 'carrd.co', 'lnk.bio', 'taplink.cc',
    'campsite.bio', 'milkshake.app', 'later.com', 'koji.to', 'snipfeed.co', 'hoo.be', 'msha.ke', 'solo.to',
];
const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|mp4|webm|woff2?)$/i;

const PHONE_CUE_RE = /(?:📞|☎️?|📱|☏|📲|\b(?:tel|telephone|phone|ph|call(?:\s+us)?|mob(?:ile)?|cell|whats\s?app|wa|contact|txt|text|sms|hotline|helpline|bookings?|appointments?|enquir(?:y|ies)|inquir(?:y|ies)|reservations?)\b)[\s:.\-–—|#]*$/i;
const PHONE_CANDIDATE_RE = /(?:\+|\b00)?\(?\d[\d\s().\-‐-―]{6,}\d/g;
const US_FORMAT_RE = /^\(?\d{3}\)?[\s.\-‐-―]\d{3}[\s.\-‐-―]\d{4}$/;
const YEAR_RANGE_RE = /^(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}$/;
const DATE_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;

/** Unicode-normalise so fancy bio fonts (𝗶𝗻𝗳𝗼＠𝗯𝗿𝗮𝗻𝗱.𝗰𝗼𝗺) become plain ASCII. */
export const plain = (s) => String(s ?? '').normalize('NFKC');

const domainOf = (email) => email.split('@')[1]?.toLowerCase() ?? '';

export function isUsableEmail(email, { fromLinkPage = false } = {}) {
    const e = email.toLowerCase();
    if (!EMAIL_FULL_RE.test(e) || FILE_EXT_RE.test(e)) return false;
    const domain = domainOf(e);
    if (JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
    if (fromLinkPage && PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
    if (/^[0-9a-f]{24,}$/.test(e.split('@')[0])) return false; // tracking ids (sentry etc.)
    return true;
}

const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Finds emails in free text (bio). Returns [{ value, evidence }].
 * @param {string} text
 * @param {string} where  label used in evidence, e.g. "bio"
 */
export function extractEmails(text, where) {
    const t = plain(text);
    const found = new Map();
    for (const m of t.matchAll(EMAIL_RE)) {
        const value = m[0].toLowerCase().replace(/\.+$/, '');
        if (isUsableEmail(value) && !found.has(value)) found.set(value, `${where}: "${clip(m[0])}"`);
    }
    for (const re of [OBF_BRACKET_RE, OBF_WORDS_RE]) {
        for (const m of t.matchAll(re)) {
            const domain = m[2].replace(new RegExp(DOT_ANY, 'gi'), '.').replace(/\s+/g, '');
            const value = `${m[1]}@${domain}`.toLowerCase();
            if (isUsableEmail(value) && !found.has(value)) {
                found.set(value, `${where} (written out): "${clip(m[0].trim())}"`);
            }
        }
    }
    return [...found].map(([value, evidence]) => ({ value, evidence }));
}

const digitsOf = (s) => s.replace(/\D/g, '');

function formatPhone(raw) {
    const trimmed = raw.trim();
    const digits = digitsOf(trimmed);
    if (trimmed.startsWith('+')) return `+${digits}`;
    if (trimmed.startsWith('00')) return `+${digits.slice(2)}`;
    return trimmed.replace(/\s{2,}/g, ' ');
}

/**
 * Finds phone numbers in free text. A digit run counts only if it starts with "+"/"00",
 * follows a phone cue (📞, call, WhatsApp, tel…), or is a US-style (xxx) xxx-xxxx number.
 */
export function extractPhones(text, where) {
    const t = plain(text);
    const found = new Map();
    for (const m of t.matchAll(PHONE_CANDIDATE_RE)) {
        const raw = m[0].trim().replace(/[\s.\-]+$/, '');
        const digits = digitsOf(raw);
        const intl = raw.startsWith('+') || raw.startsWith('00');
        const len = intl && raw.startsWith('00') ? digits.length - 2 : digits.length;
        if (len < 8 || len > 15) continue;
        if (YEAR_RANGE_RE.test(raw) || DATE_RE.test(raw) || /^(\d)\1+$/.test(digits)) continue;
        const before = t.slice(Math.max(0, m.index - 30), m.index);
        const cue = PHONE_CUE_RE.test(before);
        if (!intl && !cue && !US_FORMAT_RE.test(raw)) continue;
        const value = formatPhone(raw);
        const key = digitsOf(value);
        if (!found.has(key)) {
            const context = `${before.slice(-15)}${raw}`.trim();
            found.set(key, { value, evidence: `${where}: "${clip(context)}"` });
        }
    }
    return [...found.values()];
}

/** Phones hidden in links: wa.me/<number>, api.whatsapp.com/send?phone=, tel: */
export function phonesFromUrl(url, where) {
    const u = String(url ?? '');
    let m = u.match(/(?:wa\.me\/|whatsapp\.com\/send\/?\?(?:.*&)?phone=)\+?(\d{8,15})/i);
    if (m) return [{ value: `+${m[1]}`, evidence: `${where}: WhatsApp link "${clip(u)}"` }];
    m = u.match(/^tel:([+\d][\d\s().\-]{6,})/i);
    if (m) {
        const value = formatPhone(decodeURIComponent(m[1]));
        const len = digitsOf(value).length;
        if (len >= 7 && len <= 15) return [{ value, evidence: `${where}: tel link "${clip(u)}"` }];
    }
    return [];
}

export function emailsFromUrl(url, where) {
    const m = String(url ?? '').match(/^mailto:([^?]+)/i);
    if (!m) return [];
    const value = decodeURIComponent(m[1]).trim().toLowerCase();
    return isUsableEmail(value) ? [{ value, evidence: `${where}: mailto link "${clip(url)}"` }] : [];
}

/**
 * Contacts on a fetched link-in-bio / website page. Emails: mailto links + any address in the page source.
 * Phones: only explicit tel: and WhatsApp links (free digits on web pages are too noisy to trust).
 */
export function extractFromPage(html, pageUrl) {
    const where = `link page ${pageUrl.replace(/^https?:\/\//, '').slice(0, 60)}`;
    const emails = new Map();
    const phones = new Map();
    const body = plain(html).replace(/\\u0040/gi, '@').replace(/&#64;|&commat;/gi, '@');
    for (const m of body.matchAll(/mailto:([^"'?\s<>\\]+)/gi)) {
        for (const e of emailsFromUrl(`mailto:${m[1]}`, where)) if (!emails.has(e.value)) emails.set(e.value, e.evidence);
    }
    const text = body.replace(/<script[\s\S]*?<\/script>/gi, (s) => (s.includes('__NEXT_DATA__') || s.includes('application/json') ? s : ' '))
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    for (const m of text.matchAll(EMAIL_RE)) {
        const value = m[0].toLowerCase();
        if (isUsableEmail(value, { fromLinkPage: true }) && !emails.has(value)) emails.set(value, `${where}: "${value}"`);
    }
    for (const m of body.matchAll(/(?:href|url|link)["']?\s*[:=]\s*["'](tel:[^"'<>]+|https?:\/\/(?:wa\.me|api\.whatsapp\.com)[^"'\s<>]+)/gi)) {
        for (const p of phonesFromUrl(m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&'), where)) {
            const key = digitsOf(p.value);
            if (!phones.has(key)) phones.set(key, p);
        }
    }
    return {
        emails: [...emails].map(([value, evidence]) => ({ value, evidence })),
        phones: [...phones.values()],
    };
}

export const phoneKey = (p) => digitsOf(p);
