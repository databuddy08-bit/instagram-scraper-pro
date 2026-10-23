// Unit tests: `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, shortcodeToId, idToShortcode, parseNewerThan } from '../src/urls.js';
import { captionTags, postFromGraph, postFromV1, relatedFromPosts, postsPerDayFromPosts, mediaFromTree, placeFromHtml } from '../src/parse.js';
import { embedToMedia } from '../src/endpoints.js';

test('shortcode <-> media ID matches Instagram (Apify README samples)', () => {
    assert.equal(shortcodeToId('DZxvMgyH8yR'), '3923124318436838545');
    assert.equal(idToShortcode('3923124318436838545'), 'DZxvMgyH8yR');
    assert.equal(idToShortcode('3923124318436838545_787132'), 'DZxvMgyH8yR');
    assert.equal(shortcodeToId(idToShortcode('3369450800358839406')), '3369450800358839406');
});

test('every documented URL form parses to the right target', () => {
    const k = (u) => { const t = parseTarget(u); return t.invalid ? 'invalid' : `${t.kind}:${t.value}`; };
    assert.equal(k('https://www.instagram.com/natgeo/'), 'profile:natgeo');
    assert.equal(k('https://www.instagram.com/197622247/'), 'profileId:197622247');
    assert.equal(k('https://www.instagram.com/p/DLNsnpUTdVS/'), 'post:DLNsnpUTdVS');
    assert.equal(k('https://www.instagram.com/reels/CigMSGeD4Hd/'), 'post:CigMSGeD4Hd');
    assert.equal(k('https://www.instagram.com/p/3923124318436838545/'), 'post:DZxvMgyH8yR');
    assert.equal(k('https://www.instagram.com/explore/tags/crossfit/'), 'hashtag:crossfit');
    assert.equal(k('#Travel'), 'hashtag:travel');
    assert.equal(k('https://www.instagram.com/explore/locations/7538318/'), 'location:7538318');
    assert.equal(k('https://www.instagram.com/_u/natgeo/profilecard/'), 'profile:natgeo');
    assert.equal(k('https://www.instagram.com/stories/emiliavizcarra/'), 'profile:emiliavizcarra');
    assert.equal(k('https://www.instagram.com/humansofny/reels/'), 'profile:humansofny');
    assert.equal(k('https://www.instagram.com/share/BAC6cDeb_-'), 'share:https://www.instagram.com/share/BAC6cDeb_-');
    assert.equal(k('https://www.instagram.com/reels/audio/123/'), 'invalid');
    assert.equal(k('https://example.com/natgeo'), 'invalid');
});

test('date filter formats (UTC)', () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    assert.equal(parseNewerThan('1 day', now).toISOString(), '2026-10-22T00:00:00.000Z');
    assert.equal(parseNewerThan('2 weeks', now).toISOString(), '2026-10-09T00:00:00.000Z');
    assert.equal(parseNewerThan('2024-09-05').toISOString(), '2024-09-05T00:00:00.000Z');
    assert.equal(parseNewerThan('2024-09-05T13:22:04').toISOString(), '2024-09-05T13:22:04.000Z');
    assert.equal(parseNewerThan('2024-09-05T13:22:04.123Z').toISOString(), '2024-09-05T13:22:04.123Z');
    assert.equal(parseNewerThan(''), null);
    assert.throws(() => parseNewerThan('last tuesday'));
});

test('captions: hashtags and mentions, emails are not mentions', () => {
    const t = captionTags('Shot by @carstenpeter. Email me at jo@site.com #Travel #nature #travel');
    assert.deepEqual(t.hashtags, ['travel', 'nature']);
    assert.deepEqual(t.mentions, ['carstenpeter']);
});

test('GraphQL and mobile shapes normalize to the same post', () => {
    const g = postFromGraph({ __typename: 'XDTGraphVideo', id: '3923124318436838545', shortcode: 'DZxvMgyH8yR', is_video: true, product_type: 'clips',
        edge_media_to_caption: { edges: [{ node: { text: 'Hi #a @b' } }] }, edge_media_preview_like: { count: 10 }, edge_media_to_comment: { count: 2 },
        video_play_count: 99, taken_at_timestamp: 1750000000, owner: { id: '1', username: 'u' }, pinned_for_users: [] });
    const v = postFromV1({ pk: '3923124318436838545', code: 'DZxvMgyH8yR', media_type: 2, product_type: 'clips', caption: { text: 'Hi #a @b' }, like_count: 10,
        comment_count: 2, play_count: 99, taken_at: 1750000000, user: { pk: '1', username: 'u' } });
    for (const f of ['id', 'shortCode', 'type', 'caption', 'likesCount', 'commentsCount', 'videoPlayCount', 'timestamp', 'ownerUsername', 'productType', 'url', 'isReel']) assert.deepEqual(g[f], v[f], f);
    assert.deepEqual(g.hashtags, ['a']);
    const hidden = postFromV1({ pk: '1', code: 'X1', media_type: 1, like_count: -1 });
    assert.equal(hidden.likesCount, null);
    assert.equal(hidden.likesHidden, true);
});

test('sections tree walk, related hashtags, posts/day, place meta, embed fallback', () => {
    const tree = { sections: [{ layout_content: { medias: [{ media: { pk: '1', code: 'A', media_type: 1 } }], one_by_two_item: { clips: { items: [{ media: { pk: '2', code: 'B', media_type: 2 } }] } } } }] };
    assert.deepEqual(mediaFromTree(tree).map((m) => m.code), ['A', 'B']);
    const posts = [{ hashtags: ['x', 'y'] }, { hashtags: ['x', 'z'] }];
    assert.deepEqual(relatedFromPosts('x', posts).map((r) => r.hash), ['#y', '#z']);
    const day = 864e5;
    const ppd = postsPerDayFromPosts(Array.from({ length: 11 }, (_, i) => ({ timestamp: new Date(Date.now() - i * day).toISOString(), isPinned: false })));
    assert.equal(ppd.value, 1);
    const pl = placeFromHtml('<meta property="og:title" content="Lucerna Music Bar • Instagram"><meta property="place:location:latitude" content="50.08"><meta property="place:location:longitude" content="14.42">', '1');
    assert.equal(pl.name, 'Lucerna Music Bar');
    assert.equal(pl.lat, 50.08);
    const em = embedToMedia('<a class="UsernameText">natgeo</a><img class="EmbeddedMediaImage" src="https://x/y.jpg"><div class="Caption">natgeo Hello world<div class="CaptionComments">', 'ABC');
    assert.equal(em.owner.username, 'natgeo');
    assert.equal(postFromGraph(em).caption, 'Hello world');
});
