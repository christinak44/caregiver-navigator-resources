// Rebuilds resources.json = curated articles (source of truth: curated.json)
// + a few freshest items pulled from vetted RSS feeds, mapped to "link articles"
// (title + the feed's own summary + a link out — we never republish full bodies).
//
// Curated articles are never removed here; the feed only ADDS. Run by the weekly
// GitHub Action, and safe to run locally (node scripts/build-resources.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only feeds that expose a real, stable RSS/Atom endpoint belong here. Sources
// without a feed (NIA, ACL, FCA) are curated link-articles in curated.json instead.
const FEEDS = [
  // Caregiver-scoped VA News tag feed (not the general firehose).
  { source: 'VA Caregiver News', url: 'https://news.va.gov/tag/caregivers/feed/', category: 'VA News', max: 6 },
];
const MAX_AUTO_ITEMS = 8; // hard cap on auto-pulled items across all feeds

const stripTags = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const decode = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
   .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
   .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&hellip;/g, '…')
   .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
   .replace(/&amp;/g, '&'); // last: avoid double-decoding &amp;#38;
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(stripTags(m[1])) : '';
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

function parseItems(xml) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = tag(b, 'link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    return {
      title: tag(b, 'title'),
      link,
      description: tag(b, 'description') || tag(b, 'summary'),
      pubDate: tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published'),
    };
  });
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'user-agent': 'CaregiverNavigatorBot/1.0' } });
    if (!res.ok) { console.warn(`skip ${feed.source}: HTTP ${res.status}`); return []; }
    const items = parseItems(await res.text()).filter((i) => i.title && i.link).slice(0, feed.max);
    return items.map((i) => {
      const summary = (i.description || '').slice(0, 240).trim() || `Latest from ${feed.source}.`;
      return {
        id: `feed-${slug(feed.source)}-${slug(i.title)}`,
        category: feed.category,
        title: i.title,
        summary,
        readTime: 'Link',
        sourceUrl: i.link,
        updatedAt: i.pubDate && !Number.isNaN(Date.parse(i.pubDate))
          ? new Date(i.pubDate).toISOString()
          : new Date().toISOString(),
        tags: [slug(feed.source)],
        content: `${summary}\n\nSource: ${feed.source}\nRead the full article: ${i.link}`,
      };
    });
  } catch (e) {
    console.warn(`skip ${feed.source}: ${e.message}`);
    return [];
  }
}

const curated = JSON.parse(readFileSync(join(ROOT, 'curated.json'), 'utf8'));
const curatedIds = new Set(curated.map((a) => a.id));

let auto = [];
for (const feed of FEEDS) auto.push(...(await fetchFeed(feed)));
auto = auto
  .filter((a) => !curatedIds.has(a.id))
  .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  .slice(0, MAX_AUTO_ITEMS);

const articles = [...curated, ...auto];
const outPath = join(ROOT, 'resources.json');

// Only rewrite when the article set actually changed — ignore version/updatedAt churn
// so the Action doesn't commit an empty diff every week.
let prevArticles = '';
try { prevArticles = JSON.stringify(JSON.parse(readFileSync(outPath, 'utf8')).articles); } catch { /* first run */ }
if (JSON.stringify(articles) === prevArticles) {
  console.log(`No article changes (${curated.length} curated + ${auto.length} auto).`);
} else {
  const payload = { version: Date.now(), updatedAt: new Date().toISOString(), articles };
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote resources.json: ${curated.length} curated + ${auto.length} auto.`);
}
