# 📸 Instagram Scraper Pro — Posts, Reels, Comments, Profiles, Hashtags & Places

Scrape public Instagram data in one tool:
- posts and reels;
- comments and replies;
- mentions (posts where a profile is tagged);
- details of profiles, hashtags and places;
- discovery by search.

It also adds what plain scrapers leave out:
- **engagement rate** for every post and profile;
- **emails and phones from bios**, with evidence;
- **related hashtags measured from real posts**;
- **numeric post IDs** accepted anywhere;
- a **free status row for every input that fails**, saying how to fix it.

**Keywords:** instagram scraper · instagram api alternative · instagram post scraper · instagram reels scraper · instagram comments scraper · instagram profile scraper · instagram hashtag scraper · instagram location scraper · engagement rate · influencer research · brand monitoring · UGC

---

## ✨ What's different

| | This actor | Typical Instagram scrapers |
|---|---|---|
| Posts, reels, comments, replies, mentions, profile, hashtag and place details, search | ✅ | ✅ |
| **Numeric post IDs** (`/p/3923124318436838545/`) in every mode | ✅ | comments only |
| **Engagement rate %** on every post (from the owner's followers) and profile | ✅ | ❌ |
| **Business email, phone and address, plus emails and phones in bios** — with the exact source | ✅ | ❌ |
| **Related hashtags from the hashtag's own posts**, with counts; posts/day estimate with its basis | ✅ | third-party estimates |
| Hidden like counts returned as `null` with `likesHidden: true`, never a fake number | ✅ | `-1` |
| Filters: date, skip pinned, min likes, min comments | ✅ | date and pinned |
| **Skip items saved in previous runs**, so scheduled runs only pay for new items | ✅ | ❌ |
| Inputs that fail get a row with `status` and `fixHint`, never charged | ✅ | ❌ |
| `DIAGNOSTICS` record: which Instagram methods worked in your run | ✅ | ❌ |

## 🔒 What Instagram shows without a login (tested October 2026)

Instagram decides what logged-out visitors may see, and it changes this often. This actor tries several methods per data type and reports exactly what happened.

| Data | Logged-out status | What you get |
|---|---|---|
| Profile posts (by username or ID) | ✅ Works | Full post data, paginated |
| Profile reels tab | ✅ Works | Full reel data with play counts |
| Profile details | ⚠️ Often login-walled | When walled, a **partial profile** from the public feed: name, ID, verified, private, avg likes/comments, last post and latest 12 posts. `missingFields` lists what Instagram withheld (followers, bio, contacts). Nothing is guessed. |
| Comments, mentions, single-post details, hashtags, places, search | ⚠️ Usually login-walled | A free `login_required` row explaining it. The actor detects the wall after 2 tries and stops spending proxy traffic on it. |

The first input of every run goes alone, to learn which methods work before scaling to 25 parallel inputs. Every run writes `DIAGNOSTICS` with per-method results.

## 🔧 Input

**Mode 1: URLs.** Paste one or more URLs and pick **Content to scrape**:

| URL | Posts | Reels | Comments | Mentions | Details |
|---|---|---|---|---|---|
| Profile (`instagram.com/nike/`, `@nike`, profile ID) | ✅ | ✅ | — | ✅ | ✅ profile |
| Post or reel (`/p/…`, `/reel/…`, numeric ID, share link) | — | — | ✅ | — | ✅ post |
| Hashtag (`/explore/tags/travel/`, `#travel`) | ✅ | ✅ | — | — | ✅ hashtag |
| Place (`/explore/locations/7538318/`) | ✅ | ✅ | — | — | ✅ place |

`_u`, `profilecard`, story links and `/share/` links are handled automatically.

**Mode 2: search.** This is used only when no URLs are given. Enter comma-separated terms and choose hashtags, profiles or places. Each hit is then scraped with the content type you picked.

```json
{
  "directUrls": ["https://www.instagram.com/natgeo/", "#travel"],
  "resultsType": "posts",
  "resultsLimit": 50,
  "onlyPostsNewerThan": "30 days",
  "skipPinnedPosts": true,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

| Option | What it does |
|---|---|
| `resultsLimit` | Results per URL or search hit. |
| `maxItems` | Cap on results for the whole run (0 = none). |
| `onlyPostsNewerThan` | A relative period (`3 days`, `2 weeks`) or a date (`2024-09-05`, `2024-09-05T13:22:04Z`), in UTC. |
| `skipPinnedPosts`, `minLikes`, `minComments` | Post filters. Posts they remove are never charged. |
| `isNewestComments`, `includeNestedComments` | Comment order, and whether to include replies (each reply is its own row). |
| `addParentData` | Adds the profile, hashtag, place or post each row came from. |
| `skipPreviouslyScraped` | Skips IDs already saved by earlier runs. |
| `saveRawResponses` | Debug only: stores raw Instagram responses. |

## 📤 Output

Every row has a `status` and a `resultType` (`post`, `reel`, `mention`, `comment`, `reply`, `profile`, `hashtag`, `place`), plus `inputUrl`, `dataSource` and `scrapedAt`.

**Post or reel:**
- `id`, `shortCode`, `url`, `type`, `productType`;
- `caption`, `hashtags`, `mentions`;
- `likesCount`, `likesHidden`, `commentsCount`, `videoViewCount`, `videoPlayCount`, `videoDuration`;
- **`engagementRate`**, `ownerFollowersCount`, `timestamp`;
- `displayUrl`, `videoUrl`, `images`, `childPosts`;
- `ownerUsername`, `ownerFullName`, `ownerId`;
- `taggedUsers`, `coauthorProducers`, `locationName`, `musicInfo`;
- `isPinned`, `isSponsored`, `isCommentsDisabled`, `firstComment`, `latestComments`.

**Comment:**
- `postUrl`, `commentUrl`, `id`, `text`;
- `ownerUsername`, `ownerId`, `ownerProfilePicUrl`, `ownerIsVerified`;
- `timestamp`, `likesCount`, `repliesCount`, `parentCommentId`, `isReply`.

**Profile:**
- `username`, `fullName`, `biography`, `externalUrls`;
- `followersCount`, `followsCount`, `postsCount`;
- `verified`, `private`, `isBusinessAccount`, `businessCategoryName`, `category`;
- **`businessEmail`, `businessPhone`, `businessAddress`, `emailsFromBio`, `phonesFromBio`, `contactEvidence`**;
- **`avgLikes`, `avgComments`, `engagementRate`, `lastPostAt`**;
- `relatedProfiles`, `latestPosts`.

**Hashtag:**
- `name`, `postsCount`;
- **`relatedHashtags`** (with `postsInSample` and `sharePct`);
- **`postsPerDayEstimate`** with `postsPerDayBasis`;
- `topPosts`, `latestPosts`.

**Place:**
- `locationId`, `name`, `category`, `phone`, `website`;
- `lat`, `lng`, `address`, `city`, `zip`;
- `postsCount`, `igBusinessUsername`, `hoursStatus`;
- `topPosts`, `latestPosts`.

**Failed input:**
- `status`: `login_required`, `blocked`, `not_found`, `private`, `no_results`, `duplicate_input`, `invalid_input` or `unsupported_combination`;
- `error` and `fixHint`.

The dataset has five views: Overview, Posts & reels, Comments, Profiles and Failed inputs.

## 📊 Run records

Each run writes two records to Storage → Key-value store:
- **`RUN_SUMMARY`** lists, per input, what was saved, what was skipped and why, and which method fetched it. It also has charged events and request counts.
- **`DIAGNOSTICS`** gives, for each Instagram method, its attempts, successes, block statuses and last problem. If inputs come back `blocked`, this record shows the developer exactly what to fix.

## 💰 Pricing

| Event | When |
|---|---|
| `instagram-item` | Each post, reel, comment, reply or mention saved |
| `instagram-details` | Each profile, hashtag or place details row saved |

Failed inputs, duplicates, items from previous runs and filtered items are **never charged**. Set "Max cost per run" and the run stops cleanly at your budget.

## ❓ FAQ

**Do I need an Instagram account?** No. It reads what Instagram shows logged-out visitors.

**Why do counts differ from what I see in the app?** Logged-out visitors see slightly different numbers, and counts change by the minute. Open the post in a private window and compare it with the run's timestamp.

**Some inputs say `login_required`.** Instagram showed its login wall for that data type, and no method got past it. It isn't charged. Run again later; Instagram opens and closes these walls often.

**Some inputs say `blocked`.** Keep Apify Proxy on **RESIDENTIAL** and run again; new IPs often get through. If it keeps happening, send the `DIAGNOSTICS` record to the developer.

**Can it scrape private accounts?** No. Profile details of a private account are returned, but its posts are not.

**Why is a reels run labelled "filtered from profile posts"?** When the reels tab can't be loaded, reels are taken from the main profile feed instead. The result is the same data, but older reels may be missed.

## ⚖️ Notes

This actor collects only publicly available Instagram data. Some public data may be personal data under GDPR and similar laws. Scrape only with a legitimate purpose, and respect Instagram's terms.
