# Cruise Ship Inspection Scores — Architecture Document

**Component:** Ship Scores Browse Page (SafePort Portal / Health Canada)  
**Version:** 2.0 — Bilingual Single-Page Design  
**Date:** 2026-02-26  
**Author:** Akram Farhat  

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Bilingual URL Architecture (Option A)](#2-bilingual-url-architecture)
3. [Web Template Design](#3-web-template-design)
4. [Data Flow](#4-data-flow)
5. [Lazy Loading & Cache](#5-lazy-loading--cache)
6. [DOM Tree Hierarchy](#6-dom-tree-hierarchy)
7. [Accessibility Architecture](#7-accessibility-architecture)
8. [Search & Filtering](#8-search--filtering)
9. [Bilingual i18n Strategy](#9-bilingual-i18n-strategy)
10. [CSS Architecture](#10-css-architecture)
11. [OData Query Details](#11-odata-query-details)
12. [Deployment Checklist](#12-deployment-checklist)
13. [File Inventory](#13-file-inventory)

---

## 1. System Overview

The Cruise Ship Inspection Scores page is a **read-only, public-facing, single-page** component of the SafePort Portal. It displays inspection scores for cruise ships organized into a two-tier disclosure tree (Cruise Lines → Vessels → Inspection History) with real-time search filtering and lazy-loaded inspection data.

### Architecture Layers

```
Browser (Client)
  ├── shipScores.js    IIFE — OData loading, tree building, search, lazy cache
  ├── shipScores.css   Tree layout, WET4 focus rings, search UX, responsive
  └── Web Template     Liquid — i18n snippets, template cloning, HTML shell

Power Pages (Server)
  ├── Web API (OData)  /_api/ethi_vessels, /_api/incidents
  ├── Liquid Rendering Snippet-driven i18n, server-rendered ship template
  └── Site Settings    Anonymous read permissions, ethiEnvironment

Dataverse
  ├── ethi_vessels     ethi_name, ethi_vesselid, ethi_OwnerId, ethi_shipweightrange
  ├── incidents        ethi_inspectionscore, ethi_inspectionenddateandtime
  └── accounts         name (cruise line), statecode
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single Web Template | One file for all includes — matches GI Report/SSI Request pattern |
| Bilingual compound slug (Option A) | Same slug in both languages; no infrastructure; GC-compliant |
| Native `<details>`/`<summary>` | Zero-library disclosure; correct semantics for screen readers |
| Lazy per-vessel loading | Avoids N+1 vessel queries on page load; instant re-expand via cache |
| Template cloning | Liquid bakes bilingual text; JS clones DOM, no i18n duplication in JS |

---

## 2. Bilingual URL Architecture

### Option A — Bilingual Compound Slugs (Recommended)

Per the bilingual URL options analysis, all SafePort Portal pages use **Option A**: rename URL slugs to bilingual compound names. This is the lowest-effort, zero-risk approach that is fully compliant with Government of Canada Official Languages Act requirements.

### URL Mapping (All Portal Pages)

| Page | English URL | French URL |
|------|-------------|------------|
| GI Report | `/en/Rapport-GI-Report/` | `/fr/Rapport-GI-Report/` |
| SSI Request | `/en/Demande-SSI-Request/` | `/fr/Demande-SSI-Request/` |
| **Ship Scores** | **`/en/Resultats-Navires-Ship-Scores/`** | **`/fr/Resultats-Navires-Ship-Scores/`** |

**Pattern:** French-keyword(s) + English-keyword(s) → bilingual compound name  
**Production domain:** `port.canada.ca` ("port" is the same in both languages)

### How It Works

```
User clicks language toggle (#wb-lng a[hreflang])
         │
         ▼
ethiLibrary.js → rewriteLanguageToggle() IIFE
         │
         ├── Read: window.location.pathname.toLowerCase()
         │         e.g. "/en/resultats-navires-ship-scores/"
         │
         ├── Lookup in mappings{}
         │         → "/fr/Resultats-Navires-Ship-Scores/"
         │
         ├── Append: window.location.search (preserves ?params)
         │
         └── Set: link.setAttribute('href', newHref)
                  Rewrite happens ONCE on page load (IIFE)
```

### Language Toggle Code (ethiLibrary.js)

```javascript
var mappings = {
  // GI Report
  '/en/rapport-gi-report/':              '/fr/Rapport-GI-Report/',
  '/fr/rapport-gi-report/':              '/en/Rapport-GI-Report/',

  // SSI Request
  '/en/demande-ssi-request/':            '/fr/Demande-SSI-Request/',
  '/fr/demande-ssi-request/':            '/en/Demande-SSI-Request/',

  // Cruise Ship Inspection Scores
  '/en/resultats-navires-ship-scores/':  '/fr/Resultats-Navires-Ship-Scores/',
  '/fr/resultats-navires-ship-scores/':  '/en/Resultats-Navires-Ship-Scores/'
};
```

**Key rules:**
- Keys are **lowercase** (comparison via `.toLowerCase()`)
- Values preserve **proper casing** of the destination slug
- `window.location.search` is appended to preserve query parameters
- Source of truth for current path is always `window.location.pathname` (never Liquid `request.path`)

### Portal Management Setup

**Step 1:** Rename URL slugs in Portal Management App

| Entity | Field | Old Value | New Value |
|--------|-------|-----------|-----------|
| Web Page (EN) | Partial URL | `cruise-ship-inspection-scores` | `Resultats-Navires-Ship-Scores` |
| Web Page (FR) | Partial URL | `resultats-inspections-navires-croisiere` | `Resultats-Navires-Ship-Scores` |

**Step 2:** Both Web Pages reference the same Page Template  
**Step 3:** Page Template references the `eTHI-ShipScores-Layout` Web Template  
**Step 4:** Deploy updated `ethiLibrary.js` with new mappings

### Why Not Other Options?

| Option | Effort | Risk | Verdict |
|--------|--------|------|---------|
| A. Bilingual Slugs | 2–4 hrs | None | ✅ Recommended |
| B. Keep EN Slugs | 1–2 hrs | None | Acceptable but partial compliance |
| C. Azure Front Door | 40–80 hrs | High | ❌ Over-engineered |
| D. Duplicate Pages | 80–160 hrs | Very High | ❌ Maintenance nightmare |
| E. JS URL Rewrite | 8–16 hrs | High | ❌ history.replaceState breaks bookmarks |

---

## 3. Web Template Design

### Consolidated Includes Pattern

The Ship Scores page follows the same **single Web Template** architecture used by GI Report and SSI Request. All CSS/JS includes are centralized in one file with cache-busting versioning.

### Template Hierarchy

```
Portal Management App
  │
  ├── Page Template: "eTHI Ship Scores"
  │     └── Web Template: "eTHI-ShipScores-Layout"
  │
  ├── Web Page (EN): /en/Resultats-Navires-Ship-Scores/
  │     └── Uses Page Template: "eTHI Ship Scores"
  │
  └── Web Page (FR): /fr/Resultats-Navires-Ship-Scores/
        └── Uses Page Template: "eTHI Ship Scores"
```

### Web Template Structure

```liquid
{%- assign env = settings['ethiEnvironment'] -%}
{%- assign _ver = (env == 'dev') ? 'now' | date: '%Y%m%d%H%M%S' : 'v1' -%}

<!-- CSS (2 files) -->
<link rel="stylesheet" href="/custom.css?v={{ _ver }}">
<link rel="stylesheet" href="/shipScores.css?v={{ _ver }}">

<!-- JS (4 files, load order matters) -->
<script src="/ethiDiagnostics.js?v={{ _ver }}" defer></script>
<script src="/ethiUniversalAnnounce.js?v={{ _ver }}" defer></script>
<script src="/ethiLibrary.js?v={{ _ver }}" defer></script>
<script src="/shipScores.js?v={{ _ver }}" defer></script>

<!-- Content: search + tree + i18n data + template -->
...
```

### Comparison: Ship Scores vs GI Report Template

| Aspect | GI Report | Ship Scores |
|--------|-----------|-------------|
| CSS files | 3 (custom, validators, duetDatepicker) | 2 (custom, shipScores) |
| JS files | 10 (diagnostics, announce, library, recaptcha, validators, validations, fileNativeBridge, timeSelector, duetDatepicker, step JS) | 4 (diagnostics, announce, library, shipScores) |
| reCAPTCHA | ✅ Required (form submission) | ❌ Not needed (read-only) |
| Session timeout | ✅ Required (multi-step form state) | ❌ Not needed (stateless) |
| Validators | ✅ Required (form validation) | ❌ Not needed (no form) |
| Web Form | ✅ `{% webform %}` (multi-step) | ❌ None (OData browse) |
| Template clone | ❌ Not used | ✅ `<template>` element (ship details) |

### Cache-Busting Strategy

```
DEV:  ?v=20260226143200  (timestamp — changes every request)
PROD: ?v=v1              (manual bump on deployment)
```

Controlled by `ethiEnvironment` Site Setting in Dataverse.

---

## 4. Data Flow

### Phase 1: Page Load (Vessel Query)

```
1. Browser → GET /_api/ethi_vessels?$expand=incidents,owner
2. Dataverse → Return vessels[] with owner.name
3. Browser → Group by owner (cruise line), sort alphabetically
4. Build liner <details> nodes (h2 headings)
5. Build ship <details> nodes (h3 headings)
6. Bind a11y + search
7. Apply search filter
```

**Timing:** ~1–3s depending on vessel count

### Phase 2: Ship Expand (Lazy Load)

```
1. User clicks/Enter on ship summary
2. JS checks __InspectionCache
   ├── Cache HIT → render instantly (0ms)
   └── Cache MISS → "Loading..." → GET /_api/incidents?vessel=<id>
3. Dataverse → Return inspection rows[]
4. Client-side 5-year filter (isWithinLastYears)
5. Render into <tbody>
6. Focus h4 heading (SR lands inside content)
```

**Cached:** instant | **Fresh:** ~0.5–1.5s

---

## 5. Lazy Loading & Cache

### Cache Object

```javascript
__InspectionCache = {
  "6045bdf9-b010-...": {
    loaded: true,
    loading: false,
    rows: [ { date: "2025-03-15", score: "98/100" }, ... ],
    promise: null
  }
}
```

### State Machine

```
NOT CACHED ──expand──► LOADING ──success──► CACHED (instant re-expand)
                          │
                        error
                          │
                          ▼
                       FAILED ──re-expand──► retries from scratch
```

**Concurrent dedup:** Second expand returns same Promise  
**Error handling:** Failed requests do NOT mark cache as loaded → allows retry  
**Lifetime:** In-memory only (resets on page reload — intentional)

---

## 6. DOM Tree Hierarchy

```html
<div id="browseTree">
  <details class="browse-tree__liner">
    <summary class="browse-tree__summary" tabindex="0">
      <h2 class="browse-tree__heading">
        <span class="browse-tree__label">Royal Caribbean Group</span>
      </h2>
    </summary>
    <div class="browse-tree__panel">
      <details class="browse-tree__ship" data-vessel-id="...">
        <summary class="browse-tree__summary" tabindex="0">
          <h3 class="browse-tree__heading">
            <span class="browse-tree__label">Symphony of the Seas</span>
          </h3>
        </summary>
        <div class="ship-details">
          <h4 class="ship-details__title" tabindex="-1">
            Vessel inspection history
          </h4>
          <section role="region" aria-labelledby="ship_hist_title_abc123">
            <table class="ship-details__table table table-striped">
              <caption class="wb-inv">Inspection history (YYYY-MM-DD)</caption>
              <thead>...</thead>
              <tbody><!-- LAZY LOADED --></tbody>
            </table>
          </section>
        </div>
      </details>
    </div>
  </details>
</div>
```

**Heading hierarchy:** h1 (page title) → h2 (liner) → h3 (ship) → h4 (section)

---

## 7. Accessibility Architecture

### Disclosure Semantics
- Native `<details>`/`<summary>` elements (zero libraries)
- `tabindex="0"` on summaries ensures tabbable
- **No `role="button"`** — would force NVDA focus mode
- Enter/Space toggles; Tab flows summary → summary

### Focus Management on Ship Expand
1. toggle event fires
2. `setRegionsTabbable(ship, true)` removes stale tabindex
3. `renderLoadingRow()` shows "Loading..."
4. OData fetch completes
5. `renderHistoryIntoShip()` renders table
6. `focusShipContent()` — h4 gets `tabindex="-1"`, receives focus (150ms delay)
7. SR announces heading text

### Platform-Specific Timing

| Platform | Announcement | Focus | Source |
|----------|-------------|-------|--------|
| NVDA/JAWS (Windows) | 400ms | 500ms | getATTiming() |
| VoiceOver (macOS) | 800ms | 1000ms | getATTiming() |
| VoiceOver (iOS) | 1000ms | 1200ms | getATTiming() |
| TalkBack (Android) | 600ms | 700ms | getATTiming() |
| Unknown/Fallback | 500ms | 100ms | CONFIG defaults |

### Screen Reader Announcements
All announcements are **bilingual** via content snippets with template variables:

| Event | EN Example | Template Vars |
|-------|-----------|---------------|
| Data loaded | "Cruise ship data loaded. 5 cruise line(s) available." | `{{liners}}` |
| Liner expanded | "Royal Caribbean expanded. 3 ship(s) available." | `{{name}}`, `{{ships}}` |
| History loaded | "Inspection history loaded. 4 inspection(s) found." | `{{count}}` |
| Error | "Error loading cruise ship data." | — |

---

## 8. Search & Filtering

### Filter Logic

```
applyFilter("sym")
│
├── For each LINER:
│   ├── linerName.includes("sym") → linerMatch
│   ├── For each SHIP inside liner:
│   │   └── shipName.includes("sym") → shipMatch
│   ├── linerVisible = linerMatch OR anyShipMatch
│   ├── If !linerVisible → hide liner + all ships
│   ├── If linerMatch → show ALL ships
│   └── If only shipMatch → show only matching ships
│
├── If query present → auto-expand visible liners
└── setStatusText(q, matchedLiners, matchedShips)
```

### Status ARIA Live
`#linerSearchStatus` has `aria-live="polite"` + `aria-atomic="true"` + `role="status"` for screen reader announcements of search result counts.

---

## 9. Bilingual i18n Strategy

### Language Detection

```javascript
function isFrench() {
  var lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
  return lang.indexOf("fr") === 0;
}
```

Uses `document.documentElement.lang` (set by Power Pages), NOT browser locale.

### i18n Sources

| Content Type | Source | Mechanism |
|-------------|--------|-----------|
| Ship/liner names | Dataverse | Data (language-neutral) |
| Section titles | Liquid snippets | Server-rendered, cloned by template |
| Search status | HTML data attributes | `#shipScores_i18n` data-status-* |
| SR announcements | HTML data attributes | `#shipScores_i18n` data-announce-* |
| Table headers | HTML data attributes | `#shipScoresText` data-* |
| "Cruise ship" label | JS function | `cruiseShipLabel()` returns EN/FR |
| Loading/empty/error | JS function | `isFrench()` ternary |

### Content Snippets Required (24 total)

**Page & Search (7):**
- `ethi-ship-scores-title`
- `ethi-ship-scores-search-label`
- `ethi-ship-scores-search-help`
- `ethi-ship-scores-search-status-loading`
- `ethi-ship-scores-search-status-empty`
- `ethi-ship-scores-search-status-template`
- `ethi-ship-scores-search-status-none`

**Table Structure (5):**
- `ethi-ship-scores-date-header`
- `ethi-ship-scores-score-header`
- `ethi-ship-scores-history-title`
- `ethi-ship-scores-history-caption`
- `ethi-ship-scores-cruise-ship`

**Loading/Error (3):**
- `ethi-ship-scores-loading`
- `ethi-ship-scores-no-history`
- `ethi-ship-scores-error`

**Screen Reader Announcements (9):**
- `ethi-ship-scores-announce-data-loaded`
- `ethi-ship-scores-announce-data-error`
- `ethi-ship-scores-announce-liner-expanded`
- `ethi-ship-scores-announce-liner-collapsed`
- `ethi-ship-scores-announce-ship-expanded`
- `ethi-ship-scores-announce-ship-collapsed`
- `ethi-ship-scores-announce-history-loaded`
- `ethi-ship-scores-announce-history-empty`
- `ethi-ship-scores-announce-history-error`

---

## 10. CSS Architecture

### Design System Variables

```css
:root {
  --ship-indent: 2.5rem;
  --branch-x: 1.25rem;
  --inner-indent: 1rem;
  --node-icon-gap: .55rem;
  --wet-focus-blue: #2b6cb0;
  --wet-focus-halo: #bcdcff;
}
```

### Font Size Hierarchy

| Element | Size | Role |
|---------|------|------|
| Liner name (h2) | 1.55rem | Largest — primary grouping |
| Ship name (h3) | 1.32rem | Secondary grouping |
| Section title (h4) | 1.28rem | Content section header |
| Detail text (dt/dd) | 1.28rem | Data labels and values |
| Table header (th) | 1.21rem | Column headers |
| Table body (td) | 0.85rem | Data cells |

### !important Usage (All Justified)

Every `!important` in `shipScores.css` has an inline comment:

| Selector | Property | Reason |
|----------|----------|--------|
| `.browse-search__input:focus` | outline, box-shadow | GCWeb focus override |
| `.browse-search label i` etc. | display: none | Override Font Awesome/external icon |
| `#linerSearch` | padding-left, background-image | Override Power Pages form-control |
| `details.browse-tree__*` | border, box-shadow, background | Override Power Pages card styles |
| `summary::before` | content: none | Prevent custom pseudo-icon |
| `summary:focus` | outline, box-shadow | WET4 focus ring override |
| `.ship-details__*[tabindex]:focus` | outline, box-shadow | WET4 focus for JS-focused regions |

---

## 11. OData Query Details

### Vessel Query (Phase 1 — Page Load)

```
GET /_api/ethi_vessels
?$select=ethi_establishmenttype,ethi_name,_ethi_ownerid_value,
         ethi_vesselid,statecode,statuscode,ethi_shipweightrange
&$expand=
    ethi_Incident_Conveyance_ethi_vessel(
      $select=incidentid;
      $filter=ethi_inspectionscopetype eq 786080000
        AND ethi_finalreportcreated ne null
        AND (ethi_inspectiontype eq '05aea5d2-...'
          OR ethi_inspectiontype eq '4c5048c5-...')
    ),
    ethi_OwnerId($select=name,statecode)
&$filter=statecode eq 0
  AND ethi_Incident_Conveyance_ethi_vessel/any(o1:...)
&$top=10000
```

### Incident Query (Phase 2 — Per-Vessel Lazy Load)

```
GET /_api/incidents
?$select=_ethi_conveyance_value,ethi_inspectionenddateandtime,
         ethi_inspectionscore,statecode,statuscode
&$filter=ethi_finalreportcreated ne null
  AND statecode eq 0
  AND statuscode ne 6
  AND _ethi_conveyance_value eq <vesselId>
&$orderby=ethi_inspectionenddateandtime desc
&$top=1000
```

**GUID literal fallback:** First tries `guid'...'` syntax, retries with raw GUID on HTTP 400.  
**Client-side post-filter:** `isWithinLastYears(iso, 5)` for 5-year window.

### Inspection Type GUIDs

| Type | GUID |
|------|------|
| Routine - Announced | `05aea5d2-11eb-ef11-9342-0022486e14f0` |
| Routine - Unannounced | `4c5048c5-11eb-ef11-9342-0022486e14f0` |

---

## 12. Deployment Checklist

### URL Rename (Portal Management App)

- [ ] Rename EN Web Page partial URL: `cruise-ship-inspection-scores` → `Resultats-Navires-Ship-Scores`
- [ ] Rename FR Web Page partial URL: `resultats-inspections-navires-croisiere` → `Resultats-Navires-Ship-Scores`
- [ ] Verify both Web Pages reference same Page Template
- [ ] Verify Page Template references `eTHI-ShipScores-Layout` Web Template

### Web Template Deployment

- [ ] Create Web Template: `eTHI-ShipScores-Layout` (from `Cruise_Ship_Scores_Web_Template.liquid`)
- [ ] Create/verify Page Template pointing to it
- [ ] Verify `ethiEnvironment` Site Setting exists (`dev` or `prod`)

### File Deployment

- [ ] Upload updated `ethiLibrary.js` (new URL mappings)
- [ ] Upload updated `shipScores.css` (loading/error styles + !important comments)
- [ ] Verify `shipScores.js` loads correctly
- [ ] Bump cache-bust version if needed

### Content Snippets

- [ ] All 24 content snippets created (EN + FR values)
- [ ] Verify `#shipScores_i18n` renders all data attributes
- [ ] Verify `#shipScoresText` renders all data attributes

### Testing

- [ ] EN page loads: `/en/Resultats-Navires-Ship-Scores/`
- [ ] FR page loads: `/fr/Resultats-Navires-Ship-Scores/`
- [ ] Language toggle switches correctly (both directions)
- [ ] Tree loads with cruise line data
- [ ] Ship expand lazy-loads inspection history
- [ ] Search filters correctly
- [ ] NVDA + Chrome: announcements work
- [ ] VoiceOver + Safari: announcements work
- [ ] Mobile responsive: no horizontal scroll

---

## 13. File Inventory

| File | Type | Lines | Purpose |
|------|------|-------|---------|
| `Cruise_Ship_Scores_Web_Template.liquid` | Liquid | ~120 | Consolidated single-page template |
| `shipScores.js` | JavaScript | ~1,211 | IIFE — OData, tree, search, a11y, cache |
| `shipScores.css` | CSS | ~400 | Tree layout, focus rings, loading/error UX |
| `ethiLibrary.js` | JavaScript | ~4,987 | Shared library — includes URL mappings |
| `ethiDiagnostics.js` | JavaScript | — | Structured logging framework |
| `ethiUniversalAnnounce.js` | JavaScript | — | Cross-platform SR announcements |
| `custom.css` | CSS | — | Shared portal styles |

---

*End of Architecture Document*
