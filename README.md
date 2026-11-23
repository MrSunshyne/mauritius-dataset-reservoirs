# Mauritius Reservoirs Dataset

How full the seven main reservoirs of Mauritius are, as JSON. Each entry is a bulletin from the Water Resources Commission (WRC), with the fill level of each reservoir and of all seven together, often the same date last year and the long-term average, and the articles it was taken from.

The data goes back to January 2024. A GitHub Action looks for new bulletins at 07:00 and 15:00 UTC every day. GitHub's own schedule fires hours late or not at all, so a small Cloudflare Worker (`trigger/`) starts the workflow at those times instead, with a token that can only run this repository's workflows.

The website built on this data is [reservoirs.ramgolam.com](https://reservoirs.ramgolam.com/).

## Where the numbers come from

The WRC (Ministry of Energy and Public Utilities) measures the reservoirs, but it publishes no feed or archive. Its bulletins reach the public through the press and through Cabinet and Central Water Authority communiqués that quote them. This dataset collects those quotes:

| Source | How it is read | Backfilled from |
|---|---|---|
| [ION News](https://ionnews.mu) | WordPress.com REST API (the site's own domain blocks GitHub's runners), article text | 2024 |
| [Le Mauricien](https://www.lemauricien.com) | WordPress REST API to list articles, then the article page | 2024 |
| [News Moris](https://newsmoris.com) | WordPress REST API, article text (often an English version of a French article). Its firewall blocks GitHub's runners, so new articles are only picked up by local runs | 2024 |
| [Defimedia](https://defimedia.info) | RSS feed of the latest ~50 articles, then the article page | new articles only |
| [L'Express](https://lexpress.mu) | added by hand (the site blocks scripts) | one bulletin |

Reservoir names, capacities and descriptions come from the WRC's own page: [publicutilities.govmu.org → Water Resources Unit](https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx). The capacities add up to 92.2 Mm³, the total the bulletins use. Coordinates are the centroid of each reservoir's water polygon in [OpenStreetMap](https://www.openstreetmap.org) (linked from each entry). Districts follow OpenStreetMap's administrative boundaries.

### Limits

- **These are second-hand numbers.** A journalist copied them from a WRC table, sometimes with typos, rounding ("à 100 %") or a few reservoirs left out. Most bulletins do not name all seven reservoirs.
- **The bulletin date is not always given.** When an article says which day the figures are for ("au 18 novembre", "ce mercredi 21 octobre", "vendredi soir"), that date is used and the source is marked `"date_basis": "stated"`. Otherwise the article's publication date is used, marked `"published"`. Those figures can be a day or two older than the date says.
- **Gaps.** WRC bulletins come out about weekly, more often in a drought, and the press does not cover every one. The quiet periods have few readings: mid 2024, June to August 2025, November 2025 to January 2026, and February to March 2026.
- **No official history.** Statistics Mauritius publishes monthly minimum and maximum levels per reservoir in its yearly *Energy and Water Statistics* report. Those are not included here.

## Verification

Each reading has a `check` block and a `verified` flag. `verified` is `true` only when:

1. all seven reservoirs are reported, **and**
2. their capacity-weighted average matches the reported total within 0.5 percentage points, **or** two different outlets reported the same total (within 0.1 points) for that date.

`check` records the numbers: `reservoirs_reported`, `computed_total_percent` (Σ capacity × percent ÷ 92.2), `reported_total_percent`, `diff` (computed − reported) and `sources_agree` (`null` when only one outlet gave a total). Readings that are not verified can still be correct. Usually the article just did not list every reservoir.

As of 22 November 2026: **133 bulletin dates from 2024-01-03 to 2026-11-21, of which 44 are verified.** 55 name all seven reservoirs, and 111 give the total.

## How the history was built

`node fetch.mjs --since 2024-01-01` read 165 articles that quote the WRC. Its parser looks for reservoir names, French or English percentages and volumes, words such as "l'an dernier" or "moyenne historique", and the bulletin date. After that run, every reading was checked by hand against its article. These were corrected:

- **Two dates in one article.** "entre le 31 mars et le 11 avril, soit de 47 % à 54 %" gives two readings.
- **Earlier figures for the same day.** Figures for an earlier day ("Mardi, … 48,7 %; à hier … 46,8 %") were moved to the right date.
- **Tables in the wrong order.** News Moris printed the 2025 column first on 19 Feb 2026 and second on 22 Jan 2026.
- **Typos and rounding the parser cannot know about.** "56, 5%", "99 et 99,9 %", a total given only in the headline.
- **Articles that are not bulletins.** Opinion pieces, a Statistics Mauritius yearly summary, a minister's "remplis à 90 %", rainfall deficits and water losses quoted as percentages. These are left out, and the ones the scraper would read again are listed in `IGNORED_URLS` in `fetch.mjs`.

Spot checks, comparing the stored values with the article text:

| Date | Article | Checked |
|---|---|---|
| 2026-11-18 | [ION News, 19 Nov 2026](https://ionnews.mu/ressources-en-eau-le-taux-de-remplissage-global-des-reservoirs-recule-a-466-au-18-novembre/) | total 46.6 % (42.96 Mm³), Mare aux Vacoas 32.2 % (8.33 Mm³), La Ferme 29 %, Bagatelle 48.2 %. Last year and averages as stated, including La Ferme's 11.5 % average. |
| 2026-10-30 | [ION News, 1 Nov 2026](https://ionnews.mu/niveau-des-reservoirs-la-barre-des-50-frolee-mare-aux-vacoas-chute-drastiquement-a-338/) and [L'Express, 3 Nov 2026](https://lexpress.mu/s/le-taux-de-remplissage-chute-a-514-564346) | all seven reservoirs and 51.4 % in both. The computed total is 51.42 %. |
| 2026-10-21 | [ION News, 21 Oct 2026](https://ionnews.mu/reservoirs-taux-global-de-remplissage-a-5319-en-ce-mercredi-mare-aux-vacoas-a-34/) | 53.19 %, all seven reservoirs with last year and averages. Piton du Milieu (70.57 %, "exactement sa moyenne historique") was fixed by hand. The computed total is 53.19 %. |
| 2026-02-16 | [News Moris, 19 Feb 2026](https://newsmoris.com/reservoir-stocks-reach-64-million-m%c2%b3-as-water-crisis-levels-ease/) | 69.5 % (64.12 Mm³). The table's columns were swapped back (Mare Longue 93.2 % now, 53.8 % a year ago). The computed total is 69.53 %. |
| 2025-02-07 and 2025-02-10 | [Le Mauricien, 10 Feb 2025](https://www.lemauricien.com/actualites/societe/secheresse-de-grande-envergure-en-passe-de-toucher-le-fond/665289/) and [News Moris, 11 Feb 2025](https://newsmoris.com/only-39-mauritius-water-crisis-hits-new-low/) | Le Mauricien's figures are from Friday 7 Feb ("publiées par la WRU vendredi soir", 38.8 %). News Moris's are from Monday 10 Feb (39.6 %). They are now two readings. |
| 2024-10-25 | [Le Mauricien, 28 Oct 2024](https://www.lemauricien.com/actualites/societe/taux-alarmant-des-reserves-en-eau-du-pain-sur-la-planche-pour-le-futur-regime/654916/) | "vendredi soir … 57,4 %". The parser first took the 67 % from a month earlier. The seven reservoirs give 57.49 %. |
| 2025-04-02 | [ION News, 2 Apr 2025](https://ionnews.mu/eau-le-taux-global-de-remplissage-des-sept-reservoirs-atteint-a-494/) | La Ferme "37,5 respectivement" (no % sign). The 49.4 % total is in the headline. The computed total is 49.38 %. |

## Files

All files are at

```
https://raw.githubusercontent.com/MrSunshyne/mauritius-dataset-reservoirs/main/data/{file}
```

| File | Use |
|---|---|
| [`data/latest.json`](data/latest.json) | The newest level of each reservoir and of the total, for a dashboard or map |
| [`data/readings.json`](data/readings.json) | Every bulletin, oldest first, for charts and history |
| [`data/reservoirs.json`](data/reservoirs.json) | The seven reservoirs: capacity, location, purpose, year built |

### `data/reservoirs.json`

Largest capacity first.

```json
{
  "id": "mare-aux-vacoas",
  "name": "Mare aux Vacoas",
  "capacity_mm3": 25.89,
  "lat": -20.37463,
  "lon": 57.50376,
  "district": "Plaines Wilhems",
  "purpose": "Potable water",
  "built": 1885,
  "notes": "Largest reservoir in Mauritius, south of Curepipe. …",
  "source": "https://publicutilities.govmu.org/Pages/Water%20Sector/WRU.aspx",
  "osm": "https://www.openstreetmap.org/way/22882588"
}
```

ids: `mare-aux-vacoas`, `midlands`, `bagatelle`, `la-ferme`, `mare-longue`, `la-nicoliere`, `piton-du-milieu`.

### `data/readings.json`

One entry per bulletin date, sorted by `date`. Percentages are numbers (`"53,19 %"` → `53.19`) and volumes are in million m³. Anything a source did not give is left out. Only `date`, `date_basis`, `sources`, `check` and `verified` are always present.

```json
{
  "date": "2026-11-18",
  "date_basis": "stated",
  "total": { "percent": 46.6, "volume_mm3": 42.96 },
  "reservoirs": {
    "mare-aux-vacoas": { "percent": 32.2, "volume_mm3": 8.33 },
    "bagatelle": { "percent": 48.2, "volume_mm3": 7.12 },
    "la-ferme": { "percent": 29, "volume_mm3": 3.34 }
  },
  "last_year": { "total": { "percent": 72.5, "volume_mm3": 66.85 }, "reservoirs": { "mare-aux-vacoas": { "percent": 72, "volume_mm3": 18.65 } } },
  "average": { "total": { "percent": 57.5, "volume_mm3": 53.04 }, "reservoirs": { "mare-aux-vacoas": { "percent": 61.8 } } },
  "sources": [
    { "name": "ION News", "url": "https://ionnews.mu/…", "published": "2026-11-19", "date_basis": "stated", "total_percent": 46.6 }
  ],
  "check": { "reservoirs_reported": 3, "computed_total_percent": null, "reported_total_percent": 46.6, "diff": null, "sources_agree": null },
  "verified": false
}
```

- `last_year`: the same date a year earlier, as quoted in the bulletin.
- `average`: the long-term ("historique", "saisonnière") average for that time of year.
- `sources[].date_basis`: whether that article stated the bulletin date or only its publication date was known. The reading's own `date_basis` is `stated` if any source stated it.
- `sources[].total_percent`: the total this article gave. It is used for `sources_agree`.

When several articles report the same date, their figures are merged. The first article's value is kept, and the others only fill in what is missing.

### `data/latest.json`

```json
{
  "date": "2026-11-21",
  "total": { "percent": 46.3, "as_of": "2026-11-21" },
  "reservoirs": [
    { "id": "mare-aux-vacoas", "name": "Mare aux Vacoas", "capacity_mm3": 25.89, "…": "…",
      "percent": 31.9, "volume_mm3": 8.26, "last_year_percent": null, "average_percent": null, "as_of": "2026-11-21" }
  ],
  "sources": [ … ],
  "verified": false
}
```

Each reservoir has its most recent known level and the date of that level (`as_of`), so they can differ from one reservoir to the next. `volume_mm3` is computed from the percentage when the source gave none. `last_year_percent` and `average_percent` come from the same bulletin as `percent`. `date`, `sources` and `verified` describe the newest bulletin.

## Usage

```js
const base = 'https://raw.githubusercontent.com/MrSunshyne/mauritius-dataset-reservoirs/main/data/';

const latest = await fetch(base + 'latest.json').then((r) => r.json());
for (const r of latest.reservoirs) console.log(`${r.name}: ${r.percent} % (as of ${r.as_of})`);

// National total over time, verified bulletins only
const readings = await fetch(base + 'readings.json').then((r) => r.json());
const series = readings.filter((r) => r.verified).map((r) => [r.date, r.total?.percent ?? r.check.computed_total_percent]);
```

```sh
curl -s https://raw.githubusercontent.com/MrSunshyne/mauritius-dataset-reservoirs/main/data/latest.json | jq '.reservoirs[] | {name, percent, as_of}'
```

## Running it

Node 24, no dependencies.

```sh
node fetch.mjs                     # articles from the last 10 days before the newest bulletin
node fetch.mjs --since 2024-01-01  # every article since a date (backfill)
node fetch.mjs --dry-run           # parse and print, write nothing
```

The script skips articles it has already used, so running it twice changes nothing. If an article whose headline names a reservoir and a percentage gives no figures, it exits with an error. The workflow then opens an issue, which closes itself after the next successful run. Fix the parser, or add the URL to `IGNORED_URLS`.

## Licence

Code: MIT. The figures belong to the Water Resources Commission of Mauritius and are reported by the outlets named in each reading.
