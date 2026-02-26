# GI Report — Single Page POC Architecture (v2)

## Table of Contents

1. [File Inventory](#file-inventory)
2. [v1 → v2 Changes](#v1--v2-changes)
3. [Architecture Diagram](#architecture-diagram)
4. [Step Reorganization](#step-reorganization)
5. [Data Flow Sequences](#data-flow-sequences)
6. [Bilingual Strategy](#bilingual-strategy)
7. [Security Model](#security-model)
8. [Validation Strategy](#validation-strategy)
9. [Conditional Field Logic](#conditional-field-logic)
10. [Power Pages Configuration](#power-pages-configuration)
11. [Power Automate Flow Specification](#power-automate-flow-specification)
12. [Entity & Field Reference](#entity--field-reference)
13. [Known Gaps & TODOs](#known-gaps--todos)
14. [Testing Plan](#testing-plan)
15. [Migration from Current Implementation](#migration-from-current-implementation)

---

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `gi-report-template.html` | ~530 | Liquid web template (5 steps, fetchxml port lookups) |
| `gi-report.js` | ~640 | Form controller (nav, validation, submit, lang toggle) |
| `gi-report.css` | 390 | GCWeb-compatible styling (progress bar, responsive) |
| `GI_POC_Architecture_v2.md` | this file | Architecture documentation |

---

## v1 → v2 Changes

| Area | v1 (Current) | v2 (POC) | Impact |
|------|-------------|-----------|--------|
| Form structure | 1 step (30+ fields) + Review + Confirm | 5 steps (logical groups) + review | Better UX |
| Port lookups | Client AJAX `/_api/ethi_servicelocations` | Server-side `{% fetchxml %}` | Zero Read perms |
| Ship autocomplete | Client AJAX `/_api/ethi_ships` | Plain text inputs | Zero Read perms |
| Record creation | Direct POST `/_api/ethi_gireports` | Power Automate flow | Zero Create perms |
| reCAPTCHA | Client POST to `hca_recaptchaattempts` | Flow verifies server-side | Zero table perms |
| Language toggle | Full reload — all data lost | sessionStorage persist/restore | Seamless bilingual UX |
| Table permissions | 3 tables (Create + Read) | 0 tables | 100% reduction |
| Custom validators | ethiLibrary.js + validators.js + validations.js | wb-frmvld native | Zero custom validation JS |
| File count | ~3 custom JS files + step JS | 1 JS file (gi-report.js) | Simplified architecture |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER                               │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           gi-report-template.html                 │   │
│  │                                                    │   │
│  │  Server-side (Liquid):                            │   │
│  │    • Language detection (is_fr)                    │   │
│  │    • fetchxml: Canadian port service locations    │   │
│  │    • Bilingual labels, hints, error messages       │   │
│  │    • GI_CONFIG injection (flow URL, lang, etc.)   │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ┌──────────▼───────────────────────────────────────┐   │
│  │              gi-report.js                         │   │
│  │                                                    │   │
│  │  Step Navigation: showStep() → .step-hidden       │   │
│  │  Conditional Logic:                                │   │
│  │    initNextPortToggle() → other port field        │   │
│  │    initSubmitterToggle() → submitter section      │   │
│  │  Validation: wb-frmvld + custom (dates, counts)   │   │
│  │  Language Toggle: sessionStorage persist/restore   │   │
│  │  Submission: reCAPTCHA → Power Automate flow      │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ┌──────────▼───────────────────────────────────────┐   │
│  │   wb-frmvld (WET-BOEW Validation)                 │   │
│  │   Ignores .step-hidden fields • Error summary     │   │
│  │   aria-live announcements • Inline errors         │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────┐  ┌──────────────┐                 │
│  │  sessionStorage   │  │  reCAPTCHA v3 │                │
│  │  Lang toggle save │  │  Token gen    │                │
│  └──────────────────┘  └──────────────┘                 │
└──────────────────────────┬──────────────────────────────┘
                           │ POST JSON + reCAPTCHA token
                           ▼
┌──────────────────────────────────────────────────────────┐
│                  POWER AUTOMATE FLOW                      │
│                                                           │
│  1. Verify reCAPTCHA (score ≥ 0.5)                       │
│  2. Validate payload (required fields, types, ranges)    │
│  3. Create Dataverse record (ethi_gireport)              │
│  4. Respond: { "id": "guid", "name": "GI-XXXXXXXXXX" } │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                      DATAVERSE                            │
│                                                           │
│  ethi_gireport — record with all submitted fields        │
│  No file columns (GI Report has no file uploads)         │
└──────────────────────────────────────────────────────────┘
```

---

## Step Reorganization

The current GI Report crams 30+ fields into a single step, creating a long, overwhelming form. The POC reorganizes these into 5 logical groups:

| Step | Title (EN) | Title (FR) | Fields | Rationale |
|------|-----------|------------|--------|-----------|
| 1 | Vessel Details | Détails du navire | 8 | Ship identification and captain — first because it anchors the report |
| 2 | Port & Voyage | Port et voyage | 7+1 | Journey details — logically follows vessel ID |
| 3 | GI Cases | Cas de MIG | 5 | Core illness data — the reason for the report |
| 4 | Contact | Coordonnées | 4+4 | Who to contact — last data entry step |
| 5 | Review & Submit | Révision et soumission | 0 (display only) | Verify before submit |

### Benefits of Reorganization

- **Reduced cognitive load**: 5–8 fields per step vs. 30+ in one screen
- **Logical grouping**: Related fields together (all port info, all case counts)
- **Progress visibility**: 5-step progress bar shows completion
- **Faster error recovery**: Validation scoped to current step only
- **Mobile-friendly**: Shorter pages, less scrolling

---

## Data Flow Sequences

### Form Submission (6 steps — simpler than SSI, no file uploads)

```
User clicks Submit
    │
    ▼
executeRecaptcha()
    │ token
    ▼
buildPayload()
    │ JSON
    ▼
POST to Power Automate
    │ { fields + token }
    ▼
Flow: verify reCAPTCHA → validate → create record
    │ { id: "guid" }
    ▼
Redirect to confirmation page
```

### Language Toggle (same as SSI)

```
EN page (/en/gi-report/)          FR page (/fr/rapport-ig/)
    │                                     │
    ▼                                     ▼
Click "Français"                   Liquid renders French
    │                                     │
    ▼                                     ▼
initLanguageToggle()              restoreFormState()
    │                                     │
    ▼                                     ▼
Serialize to sessionStorage        1. Radios first
    │ fields, radios, step             2. Wait 300ms
    │                                  3. Text/select values
    ▼                                  4. showStep(saved)
Navigate → /fr/rapport-ig/            │
                                       ▼
                                  Form restored at Step N
```

---

## Bilingual Strategy

| Layer | Mechanism | Examples |
|-------|-----------|---------|
| HTML labels | `{% if is_fr %}...{% endif %}` | All field labels, hints, required text |
| Port dropdown text | `port.ethi_namefrench` vs `ethi_nameenglish` | Port names |
| Port dropdown values | Dataverse GUIDs (language-independent) | `03fb7ebd-13e3-ef11-...` |
| JS strings | `IS_FR ? "..." : "..."` | Submit button, error messages, alerts |
| wb-frmvld errors | Auto-detects `<html lang>` | Required, email, maxlength messages |
| data-msg overrides | `data-msg="{% if is_fr %}..."` | Pattern errors (phone, IMO) |
| Page title | `document.title = legend.text()` | Step titles (legend is bilingual) |
| Time select | Same `value="HH:MM"` both languages | Display text uses AM/PM formatting |

---

## Security Model

### v1 vs v2 Comparison

| Table | v1 Permissions | v2 Permissions |
|-------|---------------|----------------|
| ethi_gireport | Create + Read | **None** (flow creates) |
| ethi_servicelocation | Read | **None** (fetchxml) |
| ethi_ship | Read | **None** (text inputs) |
| hca_recaptchaattempt | Create + Read | **None** (flow verifies) |
| **Total** | **4 tables, 6 operations** | **0 tables, 0 operations** |

### Attack Surface: 100% Reduction

**v1 (what attackers could do):**
- Read all active ships, ports, recaptcha data via Web API
- Create arbitrary GI report records
- Enumerate valid GUIDs
- Bypass client-side validation

**v2 (what attackers can do):**
- Submit to the flow URL (flow validates everything server-side)
- Nothing else — zero Web API access

---

## Validation Strategy

### Three Layers

| Layer | Handler | What It Validates |
|-------|---------|-------------------|
| 1. wb-frmvld | WET-BOEW jQuery Validate | Required, email, patterns, maxlength, min/max |
| 2. Custom JS | validateDateComparison(), validateCaseCounts() | Embarkation ≤ disembarkation, GI cases ≤ totals |
| 3. Power Automate | Flow validation actions | Required fields, lengths, GUID format, business rules |

### wb-frmvld Handles (Zero Custom Code)

- `required="required"` → bilingual "This field is required"
- `type="email"` → email format validation
- `pattern="[0-9]{10}"` + `data-msg` → bilingual phone/IMO errors
- `data-rule-maxlength="100"` → character limit
- `min="0" max="9999999"` → integer range
- Error summary at top with anchor links
- `aria-live="polite"` for screen reader announcements
- Ignores `.step-hidden` fields via the ignore selector

### Custom Validations

**Date Comparison (Step 2):** Embarkation date must be ≤ disembarkation date.
Both dates are required, validation runs when leaving Step 2.

**Case Count Validation (Step 3):** Passenger GI cases ≤ total passengers,
and crew GI cases ≤ total crew. Shows bilingual error with ARIA linkage.

---

## Conditional Field Logic

### 1. Next Port Toggle (Step 2)

```
User selects "Next Canadian Port"
    │
    ├── "Other" GUID (03fb7ebd-...) → SHOW #other-port-group
    │                                   Set required on text input
    │
    └── Any other port → HIDE #other-port-group
                          Remove required, clear value
```

### 2. Submitter Toggle (Step 4)

```
"Is the submitter the medical contact?"
    │
    ├── "Yes" (default) → HIDE #submitter-section
    │                      Strip required from submitter fields
    │
    └── "No" → SHOW #submitter-section (slideDown)
                Restore required on submitter fields
                4 fields: name, title, email, phone
```

---

## Power Pages Configuration

### Site Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `GI/FlowSubmitUrl` | `https://prod-XX...logic.azure.com/...` | Power Automate HTTP trigger |

### Table Permissions

**None required.** The GI Report POC v2 needs zero anonymous table permissions.

### Web Pages (Bilingual Pair)

| Name | Partial URL | Language | Web Template |
|------|-------------|----------|--------------|
| GI Report | `/en/gi-report/` | English | gi-report-template |
| Rapport IG | `/fr/rapport-ig/` | French | gi-report-template |

---

## Power Automate Flow Specification

### Trigger

HTTP POST with JSON body.

### Flow Actions

1. **Verify reCAPTCHA** — POST to `google.com/recaptcha/api/siteverify`. If score < 0.5 → 403.
2. **Validate Payload** — Required fields, string lengths, integer ranges, GUID format.
3. **Create Record** — Dataverse "Add a new row" to `ethi_gireport` with OData bind for `ethi_nextport`.
4. **Respond** — 200 OK with `{ "id": "guid", "name": "GI-XXXXXXXXXX" }`.

### Response Codes

| Code | Body | Reason |
|------|------|--------|
| 200 | `{ "id": "guid", "name": "GI-..." }` | Success |
| 400 | `{ "error": "Validation failed", "details": [...] }` | Invalid payload |
| 403 | `{ "error": "reCAPTCHA failed" }` | Bot detected |
| 500 | `{ "error": "Internal error" }` | Dataverse or flow failure |

### Payload Schema

```json
{
  "ethi_cruiselinename": "string (required, max 100)",
  "ethi_vesselname": "string (required, max 100)",
  "ethi_imo": "string (optional, 7-8 digits)",
  "ethi_voyagenumber": "string (required, max 100)",
  "ethi_captainsname": "string (required, max 100)",
  "ethi_captainsemailaddress": "string (required, email format)",
  "ethi_shipphonenumber": "string (required, 10 digits)",
  "ethi_shipfaxnumber": "string (optional, 10 digits)",
  "ethi_lastport": "string (required, max 100)",
  "ethi_nextport_guid": "GUID (required, ethi_servicelocation)",
  "ethi_othernextcanadianport": "string (conditional)",
  "ethi_nextcanadadate": "date (required, YYYY-MM-DD)",
  "ethi_nextcanadatime": "string (required, HH:MM)",
  "ethi_nextcanadadateandtimeportal": "datetime (computed, ISO 8601)",
  "ethi_embarkationdate": "date (required)",
  "ethi_disembarkationdate": "date (required, ≥ embarkation)",
  "ethi_reporttype": "integer (required, option set value)",
  "ethi_totalnumberofpassengersonboard": "integer (required, ≥ 0)",
  "ethi_numberofpassengergastrointestinalcases": "integer (required, ≤ passengers)",
  "ethi_totalnumberofcrewonboard": "integer (required, ≥ 0)",
  "ethi_numberofcrewgastrointestinalcases": "integer (required, ≤ crew)",
  "ethi_medicalcontactname": "string (required, max 100)",
  "ethi_medicalcontacttitle": "string (required, max 100)",
  "ethi_medicalcontactemailaddress": "string (required, email)",
  "ethi_medicalcontactphonenumber": "string (required, 10 digits)",
  "ethi_submitterismedicalcontact": "boolean",
  "ethi_yourname": "string (conditional, max 100)",
  "ethi_yourtitle": "string (conditional, max 100)",
  "ethi_youremailaddress": "string (conditional, email)",
  "ethi_yourphonenumber": "string (conditional, 10 digits)",
  "ethi_submittimeutc": "string (YYYY-MM-DD HH:MM AM/PM UTC)",
  "recaptchaToken": "string (reCAPTCHA v3 token)"
}
```

---

## Entity & Field Reference

### Main Entity: ethi_gireport (plural: ethi_gireports)

| Step | Field | Type | Req | Validation |
|------|-------|------|-----|------------|
| 1 | ethi_cruiselinename | text(100) | ✓ | maxlength |
| 1 | ethi_vesselname | text(100) | ✓ | maxlength |
| 1 | ethi_imo | text(8) | | 7-8 digit pattern |
| 1 | ethi_voyagenumber | text(100) | ✓ | maxlength |
| 1 | ethi_captainsname | text(100) | ✓ | maxlength |
| 1 | ethi_captainsemailaddress | email(100) | ✓ | email format |
| 1 | ethi_shipphonenumber | tel | ✓ | 10 digits |
| 1 | ethi_shipfaxnumber | tel | | 10 digits |
| 2 | ethi_lastport | text(100) | ✓ | maxlength |
| 2 | ethi_nextport | lookup | ✓ | fetchxml (ethi_servicelocation) |
| 2 | ethi_othernextcanadianport | text(100) | * | If "Other" port selected |
| 2 | ethi_nextcanadadate | date | ✓ | YYYY-MM-DD |
| 2 | ethi_nextcanadatime | time(select) | ✓ | HH:MM (15-min intervals) |
| 2 | ethi_nextcanadadateandtimeportal | datetime | auto | JS-assembled ISO 8601 |
| 2 | ethi_embarkationdate | date | ✓ | ≤ disembarkation |
| 2 | ethi_disembarkationdate | date | ✓ | ≥ embarkation |
| 3 | ethi_reporttype | option set | ✓ | 992800000/001/002 |
| 3 | ethi_totalnumberofpassengersonboard | integer | ✓ | 0–9999999 |
| 3 | ethi_numberofpassengergastrointestinalcases | integer | ✓ | ≤ total passengers |
| 3 | ethi_totalnumberofcrewonboard | integer | ✓ | 0–9999999 |
| 3 | ethi_numberofcrewgastrointestinalcases | integer | ✓ | ≤ total crew |
| 4 | ethi_medicalcontactname | text(100) | ✓ | maxlength |
| 4 | ethi_medicalcontacttitle | text(100) | ✓ | maxlength |
| 4 | ethi_medicalcontactemailaddress | email(100) | ✓ | email format |
| 4 | ethi_medicalcontactphonenumber | tel | ✓ | 10 digits |
| 4 | ethi_submitterismedicalcontact | boolean | ✓ | radio (Yes/No) |
| 4 | ethi_yourname | text(100) | * | If submitter ≠ medical contact |
| 4 | ethi_yourtitle | text(100) | * | If submitter ≠ medical contact |
| 4 | ethi_youremailaddress | email(100) | * | If submitter ≠ medical contact |
| 4 | ethi_yourphonenumber | tel | * | If submitter ≠ medical contact |
| — | ethi_submittimeutc | text | auto | JS timestamp |
| — | ethi_stepid | text | auto | URL parameter |

`*` = Required when conditional section is visible

### Lookup Entity: ethi_servicelocation (ports)

| Field | Type | Description |
|-------|------|-------------|
| ethi_servicelocationid | GUID | Primary key |
| ethi_nameenglish | Text | English name |
| ethi_namefrench | Text | French name |
| ethi_servicelocationtype | OptionSet | Port type (992800000/001/002) |
| ethi_travellingpublicprogram | Boolean | TPP-enrolled |
| _ethi_country_value | Lookup | Country (GUID) |

### Known GUIDs

| Entity | Name | GUID | Purpose |
|--------|------|------|---------|
| ethi_servicelocation | "Other" | 03fb7ebd-13e3-ef11-9342-6045bdf97903 | Port toggle |
| ethi_country | Canada | f23dc860-6f39-ef11-a317-000d3af44283 | Port filter |

### Report Type Option Set

| Value | EN | FR |
|-------|----|----|
| 992800000 | Initial Report | Rapport initial |
| 992800001 | Update Report | Rapport de mise à jour |
| 992800002 | Final Report | Rapport final |

---

## Known Gaps & TODOs

1. **YOUR_SITE_KEY** — Replace with actual reCAPTCHA v3 site key
2. **Flow URL** — Create Power Automate flow, add URL to `GI/FlowSubmitUrl` site setting
3. **Confirmation page** — Build web template for post-submit redirect
4. **Report type values** — Verify option set values (992800000/001/002) match Dataverse
5. **Port fetchxml** — Verify `ethi_nameenglish` / `ethi_namefrench` column names
6. **Service location types** — Verify 992800000/001/002 are the correct type values
7. **Ship autocomplete** — Could be added later as optional enhancement (requires Read perm)
8. **Time format** — Current POC uses 15-minute interval select; may need different granularity
9. **Flow URL per env** — Different URLs for DEV/STG/PROD via site settings
10. **reCAPTCHA secret** — Store in flow environment variable

---

## Testing Plan

### Phase 1: Deployment & Basic Function

- [ ] Deploy web template, JS, CSS as web files
- [ ] Create EN + FR web pages pointing to template
- [ ] Verify fetchxml renders ports in correct language/sort
- [ ] Test step navigation (all 5 steps, forward/backward)
- [ ] Test conditional fields (Other port, Submitter toggle)
- [ ] Test wb-frmvld validation (required, email, pattern, min/max)

### Phase 2: Language Toggle

- [ ] Fill steps 1-3 on EN page, click "Français"
- [ ] Verify FR page loads at Step 3 with data preserved
- [ ] Verify radios, selects, text fields all restored
- [ ] Toggle back to EN — verify round-trip preservation

### Phase 3: Accessibility

- [ ] Keyboard-only: navigate entire form without mouse
- [ ] NVDA + Chrome: title, legends, errors, form fields
- [ ] VoiceOver + Safari: rotor, navigation, error announcements
- [ ] VoiceOver + iOS: swipe nav, keyboard types (tel, email, number)
- [ ] axe DevTools: target 0 critical violations
- [ ] Color contrast: text ≥ 4.5:1, UI ≥ 3:1

### Phase 4: End-to-End Submission

- [ ] Complete all 5 steps → submit
- [ ] Verify flow receives payload, creates record
- [ ] Verify combined datetime field (ethi_nextcanadadateandtimeportal)
- [ ] Test error scenarios: flow down, invalid reCAPTCHA

### Phase 5: Cross-Browser & Responsive

- [ ] Chrome, Edge, Firefox, Safari (desktop)
- [ ] Safari iOS, Chrome Android (mobile)
- [ ] Viewports: 320px, 375px, 768px, 1366px
- [ ] Touch targets ≥ 44px on mobile

---

## Migration from Current Implementation

### What Transfers vs. What Doesn't

| Current Component | POC Equivalent | Notes |
|-------------------|----------------|-------|
| ethiLibrary.js | Not needed | wb-frmvld provides accessible validation |
| validators.js | Not needed | wb-frmvld + HTML5 attributes |
| validations.js | Not needed | data-rule-* in HTML |
| GI_Report_Step_1_Custom_JavaScript.js | gi-report.js | All logic consolidated |
| getActiveCanadianPorts() | fetchxml in template | Server-side, zero JS |
| fetchShipList() + autocomplete | Plain text inputs | Simplified (autocomplete optional later) |
| suppressStockIntRangeValidators() | Not needed | No stock PP validators to suppress |
| MutationObservers | Not needed | No PP interference to fight |
| removeBasicFormAria() | Not needed | No "basic form" aria-label generated |
| getATTiming() / UniversalAnnounce | Not needed | wb-frmvld handles SR timing |
| checkNextPort() / checkSubmissionBy() | initNextPortToggle() / initSubmitterToggle() | Same logic, simpler code |
| Combined date+time assembly | assembleDatetime() | Same approach |

### Size Comparison

| Metric | Current | POC v2 |
|--------|---------|--------|
| Web pages | 3 (Step 1, Review, Confirm) | 1 (+ confirmation) |
| Custom JS files | ~3 (step JS + library + validators) | 1 (gi-report.js) |
| Total JS lines | ~1,500+ | ~640 |
| Custom validation code | ~300 lines | ~60 lines (dates + counts) |
| workarounds / MutationObservers | Multiple | Zero |
| Table permissions required | 3 tables, 6 operations | 0 tables, 0 operations |

---

*End of Document*
