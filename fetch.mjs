#!/usr/bin/env node
// Collects Water Resources Commission (WRC) reservoir bulletins as quoted by the
// Mauritian press, parses the figures, and merges them into data/readings.json.
//
//   node fetch.mjs                     recent articles only (daily run)
//   node fetch.mjs --since 2024-01-01  backfill every article published since a date
//   node fetch.mjs --dry-run           parse and print, write nothing
//
// Zero dependencies: Node 24 built-in fetch only.

import { readFile, writeFile } from 'node:fs/promises';

const DATA_DIR = new URL('./data/', import.meta.url);
const USER_AGENT = 'mauritius-dataset-reservoirs (+https://github.com/MrSunshyne/mauritius-dataset-reservoirs)';

// WordPress sites are searched through their REST API: `body: 'api'` reads the
// article text from it, `body: 'page'` means the API hides it, so the article
// page is fetched. Defimedia only offers an RSS feed of its latest ~50 articles,
// so it adds to daily runs but cannot be backfilled.
const SOURCES = [
  {
    name: 'ION News',
    // ionnews.mu is hosted on WordPress.com. Its own domain sits behind Cloudflare,
    // which refuses GitHub Actions runners; the WordPress.com API serves the same posts.
    api: 'https://public-api.wordpress.com/wp/v2/sites/ionnews.mu/posts',
    searches: ['réservoirs', 'remplissage', 'Mare aux Vacoas'],
    body: 'api',
    required: true,
  },
  {
    name: 'Le Mauricien',
    api: 'https://www.lemauricien.com/wp-json/wp/v2/posts',
    searches: ['réservoirs', 'remplissage', 'Mare aux Vacoas'],
    body: 'page',
  },
  {
    name: 'News Moris',
    api: 'https://newsmoris.com/wp-json/wp/v2/posts',
    searches: ['reservoir', 'remplissage'],
    body: 'api',
  },
  {
    name: 'Defimedia',
    rss: 'https://defimedia.info/rss.xml',
    body: 'page',
  },
];

// Articles a human has checked and decided to leave out (not a WRC bulletin,
// or figures from other years). Listing one here also stops it failing the daily run.
const IGNORED_URLS = new Set([
  // Statistics Mauritius yearly report: 2025 minimum/maximum levels, not a bulletin.
  'https://ionnews.mu/statistiques-de-leau-en-2025-forte-baisse-des-pluies-et-episodes-meteorologiques-irreguliers/',
  // Opinion piece mixing several years and water-production losses.
  'https://ionnews.mu/letrange-enigme-ou-est-passee-leau/',
  'https://ionnews.mu/dossier-paradoxe-les-chiffres-face-au-constat-dassirvaden-la-pluie-ne-tombe-pas-la-ou-sont-les-reservoirs/',
  'https://ionnews.mu/maurice-a-sec-impact-sur-le-tourisme-les-services-publics-et-le-tissu-commercial/',
  // Rainfall deficit range read as a level.
  'https://www.lemauricien.com/actualites/societe/changement-climatique-secheresse-assirvaden-situation-critique-a-mare-aux-vacoas/705155/',
]);

// How far back the daily run looks, counted from the newest bulletin we hold.
const RECENT_DAYS = 10;
// A stated bulletin date must fall within this many days before publication.
const MAX_BULLETIN_AGE_DAYS = 21;

const RESERVOIR_PATTERNS = [
  ['mare-aux-vacoas', /Mare[\s-]+aux[\s-]+Vacoas/giu],
  ['mare-longue', /Mare[\s-]+Longue/giu],
  ['midlands', /Midlands(?:[\s-]+Dam)?/giu],
  ['la-ferme', /\bLa[\s-]+[Ff]erme\b/gu],
  ['la-nicoliere', /(?:La[\s-]+)?Nicol?i[eè]re/giu],
  ['piton-du-milieu', /Piton[\s-]+du[\s-]+Milieu/giu],
  ['bagatelle', /Bagatelle(?:[\s-]+Dam)?/giu],
];

// Phrases that introduce the all-reservoir figure.
const TOTAL_PATTERN = new RegExp(
  [
    String.raw`taux\s+(?:de\s+remplissage\s+)?(?:global|moyen|total|général)`,
    String.raw`taux\s+(?:moyen|global)\s+de\s+remplissage`,
    String.raw`remplissage\s+(?:global|moyen|total)`,
    String.raw`niveau\s+(?:global|moyen|national)`,
    String.raw`capacité\s+moyenne`,
    String.raw`moyenne\s+des\s+(?:sept|7)\s+réservoirs`,
    String.raw`(?:sept|7)\s+(?:principaux\s+|principales\s+)?(?:réservoirs|réserves|retenues)`,
    String.raw`réserves\s+d'eau\s+stockées`,
    String.raw`stockage\s+(?:total|global|moyen)`,
    String.raw`niveau\s+moyen\s+de\s+stockage`,
    String.raw`niveaux?\s+de\s+stockage\s+d'eau`,
    String.raw`taux\s+de\s+remplissage\s+des\s+(?:principaux\s+)?réservoirs`,
    String.raw`réservoirs\s+du\s+pays\s+sont`,
    String.raw`nos\s+réservoirs`,
    String.raw`niveau\s+des\s+réservoirs`,
    String.raw`overall`,
    String.raw`total\s+stored\s+volume`,
    String.raw`national\s+(?:reservoir|water)\s+(?:levels?|storage)`,
    String.raw`global\s+capacity`,
    String.raw`our\s+reservoirs`,
    String.raw`seven\s+(?:main\s+)?reservoirs`,
  ].join('|'),
  'giu',
);

const PERCENT_PATTERN = /(?<![\d.,])(\d{1,3}(?:[.,]\d+)?)\s*[.,]?\s*%/gu;
const VOLUME_PATTERN =
  /(?<![\d.,])(\d{1,3}(?:[.,]\d+)?)\s*(?:M\s?m³|Mm3|mm³|mm3|millions?\s+de\s+(?:mètres\s+cubes|m³|m3)|million\s+(?:cubic\s+met(?:re|er)s|m³|m3))/giu;

const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTH_ALT = [...FR_MONTHS, 'fevrier', 'aout', 'decembre', ...EN_MONTHS].join('|');
const DAY_MONTH = new RegExp(String.raw`(?<!\d)(\d{1,2})(?:er|st|nd|rd|th)?\s+(${MONTH_ALT})(?!\p{L})(?:,?\s+((?:19|20)\d\d))?`, 'giu');
const MONTH_DAY = new RegExp(String.raw`(?<!\p{L})(${EN_MONTHS.join('|')})\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+((?:19|20)\d\d))?`, 'giu');
const WEEKDAY_ALT = Object.keys(WEEKDAYS).join('|');
// "vendredi matin", "jeudi dernier", "as of Monday": the latest such day up to publication.
const RELATIVE_WEEKDAY = new RegExp(
  String.raw`\b(${WEEKDAY_ALT})\s+(matin|soir|après-midi|dernier)\b|\bas\s+of\s+(?:yesterday\s+)?\(?(${WEEKDAY_ALT})\b`,
  'giu',
);
const RELATIVE_YESTERDAY = /\b(?:à\s+)?hier\b|\byesterday\b/giu;

// Context cues, matched against the words around a number.
const LAST_YEAR_CUE =
  /l'an\s+dernier|l'année\s+(?:dernière|précédente|passée)|même\s+(?:période|date|époque)|pareille\s+époque|période\s+correspondante|un\s+an\s+plus\s+tôt|last\s+year|a\s+year\s+ago|same\s+(?:period|time|date|point)|this\s+time\s+last|(?:\ben|\bin|\bde)\s+(?:\p{L}+\s+)?((?:19|20)\d\d)|\d{1,2}(?:er)?\s+\p{L}+\s+((?:19|20)\d\d)/giu;
const AVERAGE_CUE =
  /moyenne\s+(?:historique|saisonnière|à\s+long\s+terme|habituelle|pour\s+cette)|habituellement|(?:pour|de)\s+la\s+moyenne\b|(?<=contre\s)une\s+moyenne|long[\s-]term\s+average|seasonal\s+(?:norm|average)|historical\s+average|average\s+for\s+(?:this|the)/iu;
const IGNORE_BEFORE =
  /(?:plus\s+de|moins\s+de|près\s+de|presque|environ|quasi(?:ment)?|autour\s+de|frôl\p{L}*(?:\s+les)?|(?:niveau|cap|barre|seuil)\s+des|(?:barre|seuil)\s+(?:de|du)|sous\s+les|au-dessus\s+(?:des|de)|en\s+dessous\s+(?:des|de)|dépass\p{L}*(?:\s+les)?|franchi\p{L}*(?:\s+les)?|supérieur\p{L}*\s+à|inférieur\p{L}*\s+à|jusqu'à|d'au\s+moins|\bover|\bnearly|\balmost|\babout|\baround|\bbelow|\babove|\bunder|\bexceed\p{L}*|\bthe\s+critical|\bat\s+least|\bup\s+to)\s*(?:la\s+barre\s+des|les|the)?\s*$/iu;
const RANGE_BEFORE = /(?:\bentre|\bbetween)\s*$/iu;
const CHANGE_BEFORE =
  /(?:baiss\p{L}*|hauss\p{L}*|diminu\p{L}*|augment\p{L}*|recul\p{L}*|chut\p{L}*|perdu|perte|déficit|bond|increase|decrease|drop|rise|surge|jump|gain|loss|lost|deficit)\b[^%\d,;]{0,40}?(?:\bde|d'environ|\bof|\bby|quelque)\s*(?:quelque|environ|près\s+de|seulement)?\s*$|fourchette\s+de\s*$/iu;
const PREVIOUS_BEFORE = /(?:passant|passe|passé|passée|passés|tombant|chutant|descendant|reculant|baissant)\s+de\s*$|\bfrom\s*$/iu;
const FORECAST_BEFORE = /pourrai(?:t|ent)|could|would|risque\s+de|prévoit|projection|d'ici|predict|conduirai(?:t|ent)|devrai(?:t|ent)|serai(?:t|ent)/iu;
// After a number, signs it is not a fill level at all: "57 % de plus", "37 % des pluies",
// "64.5% of treated water", "6% rise", "60 % de pertes", "a 23% deficit".
const NOT_A_LEVEL_AFTER =
  /^\s*(?:de\s+plus|de\s+moins|more|less|des\s+(?:pluies|précipitations|eaux)|de\s+(?:l'eau|cette\s+eau|pertes?|la\s+(?:population|pluviométrie|pluviosité))|of\s+(?!(?:its|their|the|total)\s+(?:total\s+|full\s+|storage\s+)?capacity|capacity)|rise|increase|hausse|drop|decline|baisse|surge|jump|deficit|déficit|d'augmentation|de\s+hausse|de\s+baisse)/iu;
// After a number, signs it is an earlier figure: "40 % à 38 %", "65% to 72.5%", "40,1 %, la semaine dernière".
const EARLIER_AFTER = /^\s*(?:(?:en\s+20\d\d\s+)?à\s+(?:seulement\s+)?\d|to\s+\d|,?\s*(?:la\s+semaine\s+dernière|last\s+week))/iu;
const CAPACITY_BEFORE =
  /capacit(?:é|y)(?:\s+(?:de\s+stockage|maximale|totale|brute|gross|total|storage))*\s*(?:de|of|:)?\s*$/iu;
// What may sit between a number and a "last year" / "average" cue that belongs to it:
// "72,0 % l'an dernier", "contre 55 % à la même période", "73.2% recorded during the same period".
const CUE_GAP =
  /^[\s,()%]*(?:(?:recorded|registered|enregistr\p{L}*|observ\p{L}*|affich\p{L}*|relev\p{L}*|noted|seen)\s+)?(?:(?:à|au|aux|at|for|pour|de|en|in|during|durant|on|le|lors\s+de|sur)\s+)*(?:(?:la|le|l'|les|this|the|cette|that)\s*)?$/iu;
// What may sit between a percentage and its volume (or the reverse).
const PAIR_GAP =
  /^[\s(),;:%]*(?:soit|avec|ou|or|representing|représentant|i\.e\.)?(?:\s+(?:un\s+)?(?:taux\s+de\s+remplissage(?:\s+global)?\s+de|a\s+filling\s+rate\s+of|environ))?[\s(]*$/iu;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const toNumber = (s) => Number(s.replace(',', '.'));
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000));

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|li|h\d|tr|div|br)\s*>|<br\s*\/?>/gi, '. ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/[’‘´`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*\.\s*){2,}/g, '. ')
    .trim();
}

function splitSentences(text) {
  const out = [];
  const re = /(?<=[.!?…])\s+(?=[\p{Lu}«"“(\[])/gu;
  let start = 0;
  for (const m of text.matchAll(re)) {
    out.push({ start, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  out.push({ start, text: text.slice(start) });
  return out;
}

function findDates(sentence, published) {
  const pub = published.slice(0, 10);
  const earliest = addDays(pub, -MAX_BULLETIN_AGE_DAYS);
  const found = [];
  const push = (index, iso, kind) => found.push({ index, iso, kind, inRange: iso >= earliest && iso <= pub });
  const monthIndex = (name) => {
    const n = name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const fr = FR_MONTHS.map((m) => m.normalize('NFD').replace(/\p{M}/gu, ''));
    return fr.includes(n) ? fr.indexOf(n) : EN_MONTHS.indexOf(n);
  };
  const build = (day, month, year) => {
    const d = Number(day);
    if (d < 1 || d > 31 || month < 0) return null;
    let y = year ? Number(year) : Number(pub.slice(0, 4));
    let iso = `${y}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!year && iso > addDays(pub, 1)) iso = `${y - 1}${iso.slice(4)}`;
    return iso;
  };
  for (const m of sentence.matchAll(DAY_MONTH)) {
    const iso = build(m[1], monthIndex(m[2]), m[3]);
    if (iso) push(m.index, iso, 'stated');
  }
  for (const m of sentence.matchAll(MONTH_DAY)) {
    const iso = build(m[2], monthIndex(m[1]), m[3]);
    if (iso) push(m.index, iso, 'stated');
  }
  if (!found.length) {
    const pubDay = new Date(`${pub}T00:00:00Z`).getUTCDay();
    for (const m of sentence.matchAll(RELATIVE_WEEKDAY)) {
      const target = WEEKDAYS[(m[1] ?? m[3]).toLowerCase()];
      let back = (pubDay - target + 7) % 7;
      if (back === 0 && m[2]?.toLowerCase() === 'dernier') back = 7;
      push(m.index, addDays(pub, -back), 'relative');
    }
    for (const m of sentence.matchAll(RELATIVE_YESTERDAY)) push(m.index, addDays(pub, -1), 'relative');
  }
  return found.sort((a, b) => a.index - b.index);
}

function tokenize(sentence) {
  const tokens = [];
  for (const [id, re] of RESERVOIR_PATTERNS) {
    for (const m of sentence.matchAll(re)) {
      const before = sentence.slice(Math.max(0, m.index - 40), m.index);
      const after = sentence.slice(m.index + m[0].length, m.index + m[0].length + 20);
      if (/(?:zone\s+d'alimentation|région|station|usine|bassin-versant|catchment|commune|Voil[àa])\s+(?:de\s+)?$/iu.test(before)) continue;
      if (/^\s*(?:Lower|Upper|treatment|Mall|Hotel|Hôtel)/iu.test(after)) continue;
      tokens.push({ type: 'entity', id, index: m.index, end: m.index + m[0].length });
    }
  }
  for (const m of sentence.matchAll(TOTAL_PATTERN)) tokens.push({ type: 'entity', id: 'total', index: m.index, end: m.index + m[0].length });
  for (const m of sentence.matchAll(PERCENT_PATTERN)) tokens.push({ type: 'number', unit: 'percent', value: toNumber(m[1]), index: m.index, end: m.index + m[0].length });
  // "remplis à 39,3 % et 37,5 respectivement": the last one often loses its % sign.
  for (const m of sentence.matchAll(/(?<![\d.,])(\d{1,3}[.,]\d+)(?=\s+(?:respectivement|respectively))/gu)) {
    tokens.push({ type: 'number', unit: 'percent', value: toNumber(m[1]), index: m.index, end: m.index + m[0].length });
  }
  for (const m of sentence.matchAll(VOLUME_PATTERN)) tokens.push({ type: 'number', unit: 'volume', value: toNumber(m[1]), index: m.index, end: m.index + m[0].length });
  tokens.sort((a, b) => a.index - b.index || b.end - a.end);
  // Drop tokens that overlap an earlier, longer one ("Midlands Dam" vs "Midlands").
  const kept = [];
  for (const t of tokens) if (!kept.length || t.index >= kept.at(-1).end) kept.push(t);
  return kept;
}

/**
 * Parse one article into zero or more bulletins.
 * Returns [{ date, date_basis, total, reservoirs, last_year, average }].
 */
export function parseArticle(text, published, capacities) {
  // Other countries' reservoirs make the news too; keep articles about Mauritius.
  if (!RESERVOIR_PATTERNS.some(([, re]) => text.match(re)) && !/Maurice|Mauritius|Water\s+Resources|\bCWA\b|\bWRU\b|\bWRC\b/u.test(text)) return [];
  const sentences = splitSentences(text);
  const values = []; // { sentenceIndex, entity, cls, unit, value }
  const sentenceDates = [];
  const numberMarks = []; // per sentence: where each number ends and whether it was kept as current
  let carried = null; // entity carried into sentences that name none

  sentences.forEach((s, si) => {
    const tokens = tokenize(s.text);
    sentenceDates[si] = findDates(s.text, published);
    const entities = tokens.filter((t) => t.type === 'entity');
    let pending = []; // entities waiting for a number: "A et B ... 12 % et 34 %"
    let assignedSinceEntity = false;
    // "Celle-ci s'établit à 79,3 %": a sentence naming no reservoir continues the last
    // one, but only when it still talks about storage.
    const aboutStorage =
      /taux|rempli|niveau|capacit|level|full|stock|volume|mètres\s+cubes|m³|moyenne|average|réserv/iu.test(s.text) ||
      [...s.text.matchAll(LAST_YEAR_CUE)].length > 0;
    let lastAssigned = carried && !entities.length && aboutStorage ? [carried] : [];
    const marks = (numberMarks[si] = []);
    let prevNumber = null;
    let consumedUntil = 0;
    let orphan = null;
    const assignedIds = new Set();
    const respective = /respectiv|respectifs/iu.test(s.text);
    const hasCurrent = (id) => values.some((v) => v.sentenceIndex === si && v.entity === id && v.cls === 'current');

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'entity') {
        if (t.id === 'total' || assignedSinceEntity || pending.includes('total')) pending = [t.id];
        else if (!pending.includes(t.id)) pending.push(t.id);
        assignedSinceEntity = false;
        continue;
      }

      const pre = s.text.slice(Math.max(prevNumber ? prevNumber.end : 0, consumedUntil), t.index);
      const nearPre = pre.slice(-40);
      // The words after a number; a percentage glued to its volume ("34 % (8,8 Mm³) au 21 octobre 2025")
      // reads its cue after the volume.
      const following = tokens.slice(i + 1).filter((x) => x.type === 'number');
      let postStart = t.end;
      let next = following[0];
      if (next && next.unit !== t.unit && PAIR_GAP.test(s.text.slice(t.end, next.index))) {
        postStart = next.end;
        next = following[1];
      }
      const post = s.text.slice(postStart, Math.min(next ? next.index : s.text.length, postStart + 70));

      const gap = prevNumber ? s.text.slice(prevNumber.end, t.index) : '';
      const skip = (reason) => {
        prevNumber = { ...t, assigned: false, skipped: reason };
        marks.push({ end: t.end, current: false });
      };
      // "entre 32 % et 34 %", "d'environ 25 % à 35 %": the second end of a dropped range goes too.
      if ((prevNumber?.skipped === 'range' || prevNumber?.skipped === 'context') && /^\s*%?\s*(?:et|and|à|to)\s*$/iu.test(gap)) {
        skip('context');
        continue;
      }

      let cls;
      let targets;
      if (prevNumber?.assigned && prevNumber.unit !== t.unit && PAIR_GAP.test(gap)) {
        // A volume or percent glued to the previous number shares its entity and class.
        cls = prevNumber.cls;
        targets = prevNumber.targets;
      } else {
        if (t.unit === 'volume' && CAPACITY_BEFORE.test(nearPre)) { skip('capacity'); continue; }
        if (NOT_A_LEVEL_AFTER.test(post)) { skip('context'); continue; }
        const c = classify(pre, post, published);
        cls = c.cls;
        if (cls === 'historic') { skip('historic'); continue; }
        if (cls === 'current') {
          if (RANGE_BEFORE.test(nearPre)) { skip('range'); continue; }
          if (IGNORE_BEFORE.test(nearPre) || CHANGE_BEFORE.test(nearPre) || FORECAST_BEFORE.test(pre)) { skip('context'); continue; }
          if (PREVIOUS_BEFORE.test(nearPre) || EARLIER_AFTER.test(post)) { skip('previous'); continue; }
        }
        if (c.cueEnd) consumedUntil = postStart + c.cueEnd;

        // "33,7 % à Mare-aux-Vacoas": the entity follows the number.
        const nextToken = tokens[i + 1];
        const postfix =
          nextToken?.type === 'entity' &&
          nextToken.id !== 'total' &&
          /^\s*(?:à|au|pour|at|for|in)\s+(?:la\s+|le\s+|l')?(?:réservoir\s+(?:de\s+)?)?$/iu.test(s.text.slice(t.end, nextToken.index));
        if (postfix) {
          targets = [nextToken.id];
        } else if (pending.length) {
          const open = pending.filter((id) => !(cls === 'current' && hasCurrent(id) && pending.length > 1));
          if (open.length > 1 && (respective || countRun(tokens, i, cls, s.text, published) >= 2)) {
            targets = [open[0]];
            pending = pending.filter((id) => id !== open[0]);
          } else targets = open.length ? open : [pending[0]];
        } else if (lastAssigned.length) {
          targets = lastAssigned;
        } else {
          orphan = { cls, unit: t.unit, value: t.value };
          skip('orphan');
          continue;
        }
      }

      for (const id of targets) {
        values.push({ sentenceIndex: si, entity: id, cls, unit: t.unit, value: t.value, index: t.index });
        assignedIds.add(id);
      }
      lastAssigned = targets;
      assignedSinceEntity = true;
      prevNumber = { ...t, cls, targets, assigned: true };
      marks.push({ end: t.end, current: cls === 'current' });
    }

    // "Deux réservoirs sont remplis à 100 %, notamment La Nicolière et Piton du Milieu."
    if (orphan && orphan.cls === 'current') {
      for (const e of entities) {
        if (e.id !== 'total' && !assignedIds.has(e.id)) values.push({ sentenceIndex: si, entity: e.id, cls: 'current', unit: orphan.unit, value: orphan.value, index: e.index });
      }
    }
    if (entities.length) carried = lastAssigned.length === 1 ? lastAssigned[0] : entities.at(-1).id;
  });

  // Date each sentence: its own stated date (closest before its first current
  // value, else first after), otherwise the article's main bulletin date.
  const sentenceDate = (si) => {
    // "passé de 40 % le 14 mars à 38 %": a date right after a dropped or past figure belongs to it.
    const attached = (d) => numberMarks[si].some((m) => !m.current && d.index - m.end >= 0 && d.index - m.end <= 8);
    const dates = sentenceDates[si].filter((d) => d.inRange && !attached(d));
    if (!dates.length) return null;
    const first = values.find((v) => v.sentenceIndex === si && v.cls === 'current');
    if (!first) return dates[0];
    const before = dates.filter((d) => d.index <= first.index);
    return before.length ? before.at(-1) : dates[0];
  };
  let main = null;
  for (const v of values) {
    if (v.cls !== 'current') continue;
    main = sentenceDate(v.sentenceIndex);
    if (main) break;
  }
  // No dated sentence carries a value: the latest date the article mentions
  // ("entre le 30 avril et le 2 mai" → 2 mai).
  if (!main) main = sentenceDates.flat().filter((d) => d.inRange).sort((a, b) => a.iso.localeCompare(b.iso)).at(-1) ?? null;
  const mainDate = main ? { iso: main.iso, basis: 'stated' } : { iso: published.slice(0, 10), basis: 'published' };

  const bulletins = new Map();
  const bulletinFor = (si) => {
    const own = sentenceDate(si);
    const d = own ? { iso: own.iso, basis: 'stated' } : mainDate;
    if (!bulletins.has(d.iso)) bulletins.set(d.iso, { date: d.iso, date_basis: d.basis });
    return bulletins.get(d.iso);
  };

  for (const v of values) {
    const b = bulletinFor(v.sentenceIndex);
    const capacity = v.entity === 'total' ? capacities.total : capacities[v.entity];
    if (v.unit === 'percent' && (v.value < 0 || v.value > 100)) continue;
    if (v.unit === 'volume' && v.value > capacity * 1.02) continue;
    const key = v.unit === 'percent' ? 'percent' : 'volume_mm3';
    const group = v.cls === 'current' ? b : (b[v.cls] ??= {});
    const slot = v.entity === 'total' ? (group.total ??= {}) : ((group.reservoirs ??= {})[v.entity] ??= {});
    if (slot[key] === undefined) slot[key] = v.value;
  }

  const result = [];
  for (const b of bulletins.values()) {
    for (const group of [b, b.last_year, b.average]) {
      if (!group) continue;
      const slots = [['total', group.total], ...Object.entries(group.reservoirs ?? {})];
      for (const [id, slot] of slots) {
        if (!slot) continue;
        const capacity = id === 'total' ? capacities.total : capacities[id];
        // A volume that disagrees with its own percentage was attached to the wrong thing.
        if (slot.percent !== undefined && slot.volume_mm3 !== undefined && Math.abs((slot.volume_mm3 / capacity) * 100 - slot.percent) > 3) delete slot.volume_mm3;
        if (slot.percent === undefined) (id === 'total' ? delete group.total : delete group.reservoirs[id]);
      }
    }
    const hasCurrent = b.total?.percent !== undefined || Object.keys(b.reservoirs ?? {}).length > 0;
    if (hasCurrent) result.push(b);
  }
  return result;
}

// Is this number the current figure, last year's, the long-term average, or an
// older year we do not keep? `pre` is the clause before it, `post` what follows.
function classify(pre, post, published) {
  const year = Number(published.slice(0, 4));
  const lyClass = (m) => {
    const y = Number(m[1] || m[2]) || null;
    if (!y || y === year - 1) return 'last_year';
    return y < year - 1 ? 'historic' : null;
  };
  // A cue right after the number belongs to it: "72,0 % l'an dernier". The words
  // after it up to the last cue are consumed so "même période en 2025" is not read
  // again for the next number.
  const lastCueEnd = () => Math.max(0, ...[...post.matchAll(LAST_YEAR_CUE)].map((m) => m.index + m[0].length));
  const avg = post.match(AVERAGE_CUE);
  if (avg && CUE_GAP.test(post.slice(0, avg.index))) return { cls: 'average', cueEnd: Math.max(avg.index + avg[0].length, lastCueEnd()) };
  const ly = post.matchAll(LAST_YEAR_CUE).next().value;
  if (ly && CUE_GAP.test(post.slice(0, ly.index)) && lyClass(ly)) return { cls: lyClass(ly), cueEnd: lastCueEnd() };
  // Otherwise the last cue earlier in the clause: "À la même date l'année dernière, X affichait 89,9 %".
  let best = null;
  for (const m of pre.matchAll(new RegExp(AVERAGE_CUE.source, 'giu'))) best = { cls: 'average', index: m.index };
  for (const m of pre.matchAll(LAST_YEAR_CUE)) {
    const c = lyClass(m);
    if (c && (!best || m.index > best.index)) best = { cls: c, index: m.index };
  }
  // "inférieur à celui de l'année dernière et de la moyenne, soit 67,5 %": a restatement, not the comparison.
  if (best && /\bsoit\b|\bi\.e\./iu.test(pre.slice(best.index))) best = null;
  return { cls: best?.cls ?? 'current' };
}

// How many numbers of the same class follow in a row before the next entity.
function countRun(tokens, i, cls, text, published) {
  let n = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === 'entity') break;
    if (t.unit !== tokens[i].unit) continue;
    if (classify('', text.slice(t.end, t.end + 60), published).cls === cls) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Fetching

// News sites drop the odd request; try three times, a few seconds apart.
async function request(url, headers) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return res;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
}

async function getJSON(url) {
  const res = await request(url, { accept: 'application/json' });
  return { json: await res.json(), totalPages: Number(res.headers.get('x-wp-totalpages') ?? 1) };
}

async function getText(url) {
  return (await request(url)).text();
}

// Le Mauricien (tagDiv theme): the article is the `tdb_single_content` block,
// with ad scripts between paragraphs; the next `td_block_wrap` ends it.
export function pageBody(html) {
  const start = html.indexOf('tdb-block-inner td-fix-index', html.indexOf('tdb_single_content '));
  if (start < 0) return '';
  let body = html.slice(start);
  const end = body.indexOf('class="td_block_wrap');
  if (end > 0) body = body.slice(0, end);
  body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => `<p>${m[1]}</p>`).join('');
}

async function listPosts(source, since) {
  if (source.rss) {
    const xml = await getText(source.rss);
    const tag = (item, name) => decodeEntities(item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '');
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map(([, item]) => {
        // "22 Nov 2026 15:32:48 +0400" → Mauritius local time, like WordPress `date`.
        const m = tag(item, 'pubDate').match(/(\d{1,2}) (\w{3}) (\d{4}) (\d\d:\d\d:\d\d)/);
        const month = EN_MONTHS.findIndex((x) => x.startsWith(m?.[2]?.toLowerCase() ?? '-'));
        const date = m ? `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4]}` : '';
        return { date, link: tag(item, 'link'), title: { rendered: tag(item, 'title') } };
      })
      .filter((p) => p.date && p.date.slice(0, 10) >= since);
  }
  const posts = new Map();
  for (const search of source.searches) {
    for (let page = 1; ; page++) {
      const fields = source.body === 'api' ? 'date,link,title,content' : 'date,link,title';
      const url = `${source.api}?search=${encodeURIComponent(search)}&per_page=100&page=${page}&after=${since}T00:00:00&orderby=date&order=desc&_fields=${fields}`;
      const { json, totalPages } = await getJSON(url);
      for (const p of json) posts.set(p.link, p);
      if (page >= totalPages) break;
    }
  }
  return [...posts.values()];
}

// Defimedia (Next.js): paragraphs between the "Publié le" line and the keywords footer.
export function defimediaBody(html) {
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  const start = paragraphs.findIndex((p) => /Publié le/.test(p));
  const end = paragraphs.findIndex((p) => /^\s*(?:<[^>]+>\s*)*Mots-clés/.test(p));
  if (start < 0) return '';
  const body = paragraphs.slice(start, end > start ? end : undefined);
  body[0] = body[0].replace(/^[\s\S]*?(?:A−AA\+|Partager)/, '');
  return body.map((p) => `<p>${p}</p>`).join('');
}

const RELEVANT_TITLE =
  /(?=.*(?:r[ée]servoir|reservoir|Mare[\s-]+aux[\s-]+Vacoas|Nicoli[eè]re|Midlands|La[\s-]+Ferme|Mare[\s-]+Longue|Piton[\s-]+du[\s-]+Milieu|Bagatelle))(?=.*\d+(?:[.,]\d+)?\s*%)/iu;
const CANDIDATE_TITLE =
  /r[ée]servoir|reservoir|remplissage|Mare[\s-]+aux[\s-]+Vacoas|Nicoli[eè]re|Midlands|La[\s-]+Ferme|Mare[\s-]+Longue|Piton[\s-]+du[\s-]+Milieu|Bagatelle|s[ée]cheresse|drought|\beau\b|water/iu;

// ---------------------------------------------------------------------------
// Dataset

// The check behind `verified`: all seven reservoirs reported and their
// capacity-weighted total matching the reported total within 0.5 points, or two
// different outlets reporting the same total for that date.
export function computeCheck(reading, reservoirs) {
  const check = { reservoirs_reported: 0, computed_total_percent: null, reported_total_percent: null, diff: null, sources_agree: null };
  const values = reservoirs.map((r) => reading.reservoirs?.[r.id]?.percent);
  check.reservoirs_reported = values.filter((v) => v !== undefined).length;
  check.reported_total_percent = reading.total?.percent ?? null;
  if (check.reservoirs_reported === reservoirs.length) {
    const capacity = reservoirs.reduce((s, r) => s + r.capacity_mm3, 0);
    check.computed_total_percent = round(reservoirs.reduce((s, r, i) => s + r.capacity_mm3 * values[i], 0) / capacity);
  }
  if (check.computed_total_percent !== null && check.reported_total_percent !== null) {
    check.diff = round(check.computed_total_percent - check.reported_total_percent);
  }
  const totals = new Map();
  for (const s of reading.sources) if (s.total_percent !== undefined && !totals.has(s.name)) totals.set(s.name, s.total_percent);
  if (totals.size >= 2) {
    const t = [...totals.values()];
    check.sources_agree = Math.max(...t) - Math.min(...t) <= 0.1;
  }
  const verified =
    check.reservoirs_reported === reservoirs.length &&
    ((check.diff !== null && Math.abs(check.diff) <= 0.5) || check.sources_agree === true);
  return { check, verified };
}

// Merge one parsed bulletin into a reading: fill what is missing, never overwrite.
function mergeValues(target, parsed) {
  const mergeSlot = (into, from) => {
    for (const key of ['percent', 'volume_mm3']) if (from[key] !== undefined && into[key] === undefined) into[key] = from[key];
  };
  const mergeGroup = (into, from) => {
    if (from.total) mergeSlot((into.total ??= {}), from.total);
    for (const [id, slot] of Object.entries(from.reservoirs ?? {})) mergeSlot(((into.reservoirs ??= {})[id] ??= {}), slot);
  };
  mergeGroup(target, parsed);
  if (parsed.last_year) mergeGroup((target.last_year ??= {}), parsed.last_year);
  if (parsed.average) mergeGroup((target.average ??= {}), parsed.average);
}

const READING_KEYS = ['date', 'date_basis', 'total', 'reservoirs', 'last_year', 'average', 'sources', 'check', 'verified'];

function normalizeReading(reading, reservoirs) {
  const order = reservoirs.map((r) => r.id);
  const slot = (s) => (s ? Object.fromEntries(['percent', 'volume_mm3'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) : undefined);
  const group = (g) => {
    if (!g) return undefined;
    const out = {};
    if (g.total && slot(g.total).percent !== undefined) out.total = slot(g.total);
    const res = Object.fromEntries(order.filter((id) => g.reservoirs?.[id]?.percent !== undefined).map((id) => [id, slot(g.reservoirs[id])]));
    if (Object.keys(res).length) out.reservoirs = res;
    return Object.keys(out).length ? out : undefined;
  };
  const main = group(reading) ?? {};
  const r = {
    date: reading.date,
    date_basis: reading.sources.some((s) => s.date_basis === 'stated') ? 'stated' : 'published',
    total: main.total,
    reservoirs: main.reservoirs,
    last_year: group(reading.last_year),
    average: group(reading.average),
    sources: [...reading.sources]
      .sort((a, b) => a.published.localeCompare(b.published) || a.url.localeCompare(b.url))
      .map((s) => Object.fromEntries(['name', 'url', 'published', 'date_basis', 'total_percent'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]))),
  };
  const { check, verified } = computeCheck(r, reservoirs);
  r.check = check;
  r.verified = verified;
  return Object.fromEntries(READING_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
}

export function buildLatest(readings, reservoirs) {
  const latest = readings.at(-1);
  const totalReading = [...readings].reverse().find((r) => r.total?.percent !== undefined);
  return {
    date: latest.date,
    total: totalReading ? { ...totalReading.total, as_of: totalReading.date } : null,
    reservoirs: reservoirs.map((res) => {
      const r = [...readings].reverse().find((x) => x.reservoirs?.[res.id]?.percent !== undefined);
      if (!r) return { ...res, percent: null, volume_mm3: null, last_year_percent: null, average_percent: null, as_of: null };
      return {
        ...res,
        percent: r.reservoirs[res.id].percent,
        volume_mm3: r.reservoirs[res.id].volume_mm3 ?? round((r.reservoirs[res.id].percent / 100) * res.capacity_mm3),
        last_year_percent: r.last_year?.reservoirs?.[res.id]?.percent ?? null,
        average_percent: r.average?.reservoirs?.[res.id]?.percent ?? null,
        as_of: r.date,
      };
    }),
    sources: latest.sources,
    verified: latest.verified,
  };
}

async function readJSON(name, fallback) {
  try {
    return JSON.parse(await readFile(new URL(name, DATA_DIR), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

async function writeIfChanged(name, data) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  let prev = null;
  try {
    prev = await readFile(new URL(name, DATA_DIR), 'utf8');
  } catch {}
  if (prev === next) return false;
  await writeFile(new URL(name, DATA_DIR), next);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
  const backfill = Boolean(sinceArg);

  const reservoirs = await readJSON('reservoirs.json');
  const readings = await readJSON('readings.json', []);
  const capacities = Object.fromEntries(reservoirs.map((r) => [r.id, r.capacity_mm3]));
  capacities.total = round(reservoirs.reduce((s, r) => s + r.capacity_mm3, 0));

  const known = new Set(readings.flatMap((r) => r.sources.map((s) => s.url)));
  const newest = readings.at(-1)?.date ?? '2024-01-01';
  const since = sinceArg ?? addDays(newest, -RECENT_DAYS);

  const failures = [];
  let added = 0;
  let updated = 0;
  const byDate = new Map(readings.map((r) => [r.date, r]));

  for (const source of SOURCES) {
    let posts;
    try {
      posts = await listPosts(source, since);
    } catch (err) {
      if (source.required) throw err;
      console.warn(`! ${source.name}: ${err.message}`);
      continue;
    }
    posts.sort((a, b) => a.date.localeCompare(b.date));
    for (const post of posts) {
      const title = htmlToText(post.title.rendered);
      if (known.has(post.link) || IGNORED_URLS.has(post.link)) continue;
      if (source.body === 'page' && !CANDIDATE_TITLE.test(title)) continue;
      let html;
      try {
        if (source.body === 'api') html = post.content.rendered;
        else html = (source.rss ? defimediaBody : pageBody)(await getText(post.link));
      } catch (err) {
        console.warn(`! ${post.link}: ${err.message}`);
        continue;
      }
      const text = htmlToText(html);
      const bulletins = parseArticle(text, post.date, capacities);
      if (!bulletins.length) {
        if (RELEVANT_TITLE.test(title)) failures.push(`${post.date.slice(0, 10)} ${title} — ${post.link}`);
        continue;
      }
      for (const b of bulletins) {
        const sourceEntry = { name: source.name, url: post.link, published: post.date.slice(0, 10), date_basis: b.date_basis, total_percent: b.total?.percent };
        const existing = byDate.get(b.date);
        if (existing) {
          mergeValues(existing, b);
          existing.sources.push(sourceEntry);
          updated++;
        } else {
          const reading = { date: b.date, sources: [sourceEntry] };
          mergeValues(reading, b);
          byDate.set(b.date, reading);
          added++;
        }
        console.log(`+ ${b.date} (${b.date_basis}) ${source.name}: ${summarize(b)}  ${post.link}`);
      }
      known.add(post.link);
    }
  }

  const next = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => normalizeReading(r, reservoirs));
  if (!dryRun && next.length) {
    const changedReadings = await writeIfChanged('readings.json', next);
    const changedLatest = await writeIfChanged('latest.json', buildLatest(next, reservoirs));
    console.log(`${added} new bulletin dates, ${updated} merged; readings.json ${changedReadings ? 'updated' : 'unchanged'}, latest.json ${changedLatest ? 'updated' : 'unchanged'}`);
  }

  if (failures.length) {
    console.error(`Could not parse ${failures.length} relevant article(s):\n${failures.join('\n')}`);
    if (!backfill) process.exit(1);
  }
}

function summarize(b) {
  const parts = [];
  if (b.total?.percent !== undefined) parts.push(`total ${b.total.percent}%`);
  for (const [id, v] of Object.entries(b.reservoirs ?? {})) parts.push(`${id} ${v.percent}%`);
  return parts.join(', ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
