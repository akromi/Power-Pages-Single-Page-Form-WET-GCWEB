# SSI Request — Single Page POC Architecture (v2)

## Table of Contents

1. [File Inventory](#file-inventory)
2. [v1 → v2 Changes](#v1--v2-changes)
3. [Architecture Diagram](#architecture-diagram)
4. [Data Flow Sequences](#data-flow-sequences)
5. [Bilingual Strategy](#bilingual-strategy)
6. [Security Model](#security-model)
7. [Validation Strategy](#validation-strategy)
8. [Conditional Field Logic](#conditional-field-logic)
9. [Power Pages Configuration](#power-pages-configuration)
10. [Power Automate Flow Specification](#power-automate-flow-specification)
11. [Entity & Field Reference](#entity--field-reference)
12. [Known Gaps & TODOs](#known-gaps--todos)
13. [Testing Plan](#testing-plan)
14. [Migration from Current Implementation](#migration-from-current-implementation)

---

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `ssi-request-template.html` | ~560 | Liquid web template (all 5 steps, fetchxml lookups, extensive docs) |
| `ssi-request.js` | ~900 | Form controller (nav, validation, submit, lang toggle, extensive docs) |
| `ssi-request.css` | 390 | GCWeb-compatible styling (unchanged from v1) |
| `SSI_POC_Architecture_v2.md` | this file | Setup guide + architecture documentation |

---

## v1 → v2 Changes

| Area | v1 Approach | v2 Approach | Impact |
|------|-------------|-------------|--------|
| Country/Province lookups | Client-side AJAX to `/_api/ethi_countries` | Server-side `{% fetchxml %}` in Liquid | -60 lines JS, zero Read table permissions |
| Record creation | Direct `POST /_api/ethi_ssirequestportals` | Power Automate flow with HTTP trigger | Zero Create table permissions |
| reCAPTCHA verification | Client-side POST to `hca_recaptchaattempts` table | Flow verifies server-side with Google API | Zero table permissions for reCAPTCHA |
| Language toggle | Full page reload — all data lost | sessionStorage persist/restore across toggle | Seamless bilingual UX |
| Anonymous table permissions | 4 tables (Create + Read) | 1 table (Update-only, 2 file columns) | 90% reduction in attack surface |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER                               │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           ssi-request-template.html               │   │
│  │                                                    │   │
│  │  Server-side (Liquid):                            │   │
│  │    • Language detection (is_fr)                    │   │
│  │    • fetchxml: countries, provinces                │   │
│  │    • Bilingual labels, hints, error messages       │   │
│  │    • SSI_CONFIG injection (flow URL, lang, etc.)   │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ┌──────────▼───────────────────────────────────────┐   │
│  │              ssi-request.js                       │   │
│  │                                                    │   │
│  │  Step Navigation:                                  │   │
│  │    showStep() → .step-hidden toggle               │   │
│  │    validateCurrentStep() → wb-frmvld + custom     │   │
│  │                                                    │   │
│  │  Conditional Logic:                                │   │
│  │    initCCGToggle() → invoice section               │   │
│  │    initCountryToggle() → province/state            │   │
│  │    initRegistryFlagToggle() → other flag           │   │
│  │                                                    │   │
│  │  Language Toggle:                                  │   │
│  │    initLanguageToggle() → sessionStorage save     │   │
│  │    restoreFormState() → sessionStorage restore     │   │
│  │                                                    │   │
│  │  Submission:                                       │   │
│  │    handleSubmit() → reCAPTCHA → flow → files      │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ╔══════════▼═══════════════════════════════════════╗   │
│  ║  wb-frmvld (WET-BOEW validation framework)       ║   │
│  ║                                                    ║   │
│  ║  • Error summary (numbered list, anchor links)     ║   │
│  ║  • Inline error messages per field                 ║   │
│  ║  • aria-live announcements for screen readers     ║   │
│  ║  • Ignores .step-hidden fields                    ║   │
│  ╚══════════════════════════════════════════════════╝   │
└──────────────┬──────────────────────┬───────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────────┐
    │  Power Automate      │  │  Dataverse Web API    │
    │  HTTP Trigger         │  │  (file upload only)   │
    │                      │  │                        │
    │  1. Verify reCAPTCHA │  │  PUT /ethi_ssi...     │
    │  2. Validate payload │  │    /ethi_uploadship.. │
    │  3. Create record    │  │    /ethi_existingssc  │
    │  4. Return {id}      │  │                        │
    └──────────────────────┘  └────────────────────────┘
               │                      │
               └───────────┬──────────┘
                           │
                  ┌────────▼─────────┐
                  │    Dataverse      │
                  │  ethi_ssi...      │
                  │  (record + files) │
                  └──────────────────┘
```

---

## Data Flow Sequences

### Form Submission

```
User clicks Submit (Step 5)
    │
    ▼
executeRecaptcha() ──→ Google reCAPTCHA v3
    │                      │
    │                 token returned
    ▼
buildPayload() ──→ JSON object (all fields + token)
    │
    ▼
POST to Power Automate flow URL
    │
    ├──→ Flow: Verify reCAPTCHA (score ≥ 0.5)
    │       └──→ If fail: 403 response
    │
    ├──→ Flow: Validate payload
    │       └──→ If fail: 400 response with details
    │
    ├──→ Flow: Create Dataverse record
    │       └──→ Returns { id: "record-guid" }
    │
    ▼
uploadFile() × 2 (parallel)
    │
    ├──→ PUT /ethi_uploadshipparticulars (binary)
    └──→ PUT /ethi_existingssc (binary, if present)
    │
    ▼
Redirect to confirmation page
```

### Language Toggle

```
User on /en/ssi-request/ (Step 3, partially filled)
    │
    ▼
Clicks "Français" (#wb-lng a)
    │
    ▼
initLanguageToggle() intercepts click
    │
    ├──→ Serialize text/select/textarea values by ID
    ├──→ Serialize checked radio values by name
    ├──→ Serialize file input filenames (names only)
    ├──→ Store step number
    │
    ▼
sessionStorage.setItem('ssi-form-state', JSON.stringify(state))
    │
    ▼
Navigate to /fr/demande-ssi/ (full page reload)
    │
    ▼
Liquid renders French page (labels, fetchxml in French)
    │
    ▼
ssi-request.js initialize()
    │
    ▼
restoreFormState() reads sessionStorage
    │
    ├──→ 1. Restore radio buttons (triggers CCG toggle)
    ├──→ 2. Wait 300ms (CSS transitions)
    ├──→ 3. Restore text/select values (GUIDs match across languages)
    ├──→ 4. Show file re-select warnings
    └──→ 5. Navigate to saved step (showStep(3))
    │
    ▼
User sees French page at Step 3 with all data preserved
(except files — must re-select)
```

---

## Bilingual Strategy

### How Language is Determined

Power Pages maintains paired Web Pages for each language:

| English Page | French Page | Web Template |
|-------------|-------------|--------------|
| `/en/ssi-request/` | `/fr/demande-ssi/` | `ssi-request-template` (shared) |

Both pages use the **same** web template. The Liquid engine detects the language:

```liquid
{% assign lang = webpage.adx_webpage_language.adx_languagecode | default: 'en' %}
{% assign is_fr = false %}
{% if lang == 'fr' %}{% assign is_fr = true %}{% endif %}
```

### Where Bilingual Text Lives

| Layer | Mechanism | Examples |
|-------|-----------|---------|
| HTML labels | `{% if is_fr %}Prénom{% else %}First Name{% endif %}` | All field labels, hints, error messages |
| Dropdown text | `{% if is_fr %}{{ country.ethi_namefr }}{% else %}{{ country.ethi_name }}{% endif %}` | Country names, province names |
| Dropdown values | Dataverse GUIDs (language-independent) | `f23dc860-6f39-ef11-a317-000d3af44283` |
| JS strings | `IS_FR ? 'Soumission en cours…' : 'Submitting…'` | Submit button, error alerts, file warnings |
| wb-frmvld errors | Auto-switches based on `<html lang>` | Required, email, maxlength messages |
| data-msg overrides | `data-msg="{% if is_fr %}...{% else %}...{% endif %}"` | Pattern errors (phone, IMO, business number) |
| Page title | `document.title = legend.text()` (legend is already bilingual) | Step titles |

### Why GUID-Based Selects Enable Language Toggle

Select `<option>` values are Dataverse GUIDs — identical on both language pages:

```html
<!-- English page -->
<option value="f23dc860-...">Canada</option>
<option value="a1b2c3d4-...">United States</option>

<!-- French page (same template, same fetchxml, different text) -->
<option value="f23dc860-...">Canada</option>
<option value="a1b2c3d4-...">États-Unis</option>
```

When `restoreFormState()` sets `el.value = "a1b2c3d4-..."`, the correct option is selected regardless of display language.

---

## Security Model

### Attack Surface Comparison

| Component | v1 Permissions | v2 Permissions |
|-----------|---------------|---------------|
| `ethi_ssirequestportal` | Create + Read | Update (2 file columns only) |
| `ethi_country` | Read | None (fetchxml) |
| `ethi_province` | Read | None (fetchxml) |
| `hca_recaptchaattempt` | Create | None (flow handles) |
| **Total exposed tables** | **4** | **1** |
| **Total exposed operations** | **Create + Read × 4** | **Update × 1 (scoped)** |

### Why This Matters

With v1, an attacker could:
- Enumerate all countries/provinces (Read on lookup tables)
- Create arbitrary records in the SSI table (Create permission)
- Potentially bypass client-side validation (direct API POST)
- Create reCAPTCHA attempt records

With v2, an attacker can only:
- Write to 2 file columns on an existing record (Update, scoped)
- They cannot create records (flow does that with server-side validation)
- They cannot read any data (no Read permissions)

### File Upload Security

Files are still uploaded via Web API `PUT` because:
- Power Automate HTTP triggers have payload size limits (~100 MB, but base64 encoding doubles file size)
- Binary handling in Power Automate is more complex than direct PUT
- The scoped Update permission (2 file columns only) limits the attack surface

The table permission should be configured with **Column Permissions** restricting Update to only `ethi_uploadshipparticulars` and `ethi_existingssc`.

---

## Validation Strategy

### Three Layers

| Layer | Handler | What It Validates |
|-------|---------|-------------------|
| **1. wb-frmvld** | WET-BOEW jQuery Validate | Required fields, email format, patterns, maxlength, postalCodeCA |
| **2. Custom JS** | `validateFiles()`, `validateDateComparison()` | File size/type/empty, arrival ≤ departure |
| **3. Power Automate** | Flow validation actions | Required fields, string lengths, GUID format, business rules |

### wb-frmvld Configuration

The `data-wb-frmvld` attribute on the wrapper div:

```json
{ "ignore": ".step-hidden input, .step-hidden select, .step-hidden textarea" }
```

This tells jQuery Validate to skip fields inside hidden steps. When `showStep()` removes `.step-hidden` from a fieldset, its fields become eligible for validation.

### What wb-frmvld Handles (Zero Custom Code)

- `required="required"` → "This field is required" (bilingual)
- `type="email"` → Email format validation
- `pattern="[0-9]{10}"` → Custom pattern with `data-msg` bilingual error
- `data-rule-maxlength="100"` → Max character count
- `data-rule-postalCodeCA="true"` → Canadian postal code (A1A 1A1)
- Error summary at top of form with anchor links to each error
- Inline error messages per field
- `aria-live="polite"` region for screen reader announcements

---

## Conditional Field Logic

### CCG Toggle (Step 2)

```
ethi_canadiancoastguard = "true" (Yes)
    └──→ #invoice-section: slideUp, strip required from all fields
    
ethi_canadiancoastguard = "false" (No)
    └──→ #invoice-section: slideDown, restore required attributes
```

**Implementation:** `initCCGToggle()` uses `data-was-required` attribute to remember which fields should be required when the section is re-shown.

### Country Toggle (Step 2, inside invoice section)

```
ethi_invoicecountry = GUID_CANADA ("f23dc860-...")
    ├──→ Show: #invoice-province-group (Province dropdown)
    ├──→ Show: #invoice-postalcode-group (Postal Code with CA validation)
    ├──→ Hide: #invoice-state-group (State text)
    └──→ Hide: #invoice-zipcode-group (ZIP Code)

ethi_invoicecountry = any other GUID
    ├──→ Hide: #invoice-province-group
    ├──→ Hide: #invoice-postalcode-group
    ├──→ Show: #invoice-state-group
    └──→ Show: #invoice-zipcode-group
```

### Registry Flag Toggle (Step 3)

```
ethi_flaginregistry = GUID_OTHER_REGISTRY ("f8fad702-...")
    └──→ Show: #other-registry-group (Other Registry Flag text input)

ethi_flaginregistry = any other GUID
    └──→ Hide: #other-registry-group
```

---

## Power Pages Configuration

### Site Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `SSI/FlowSubmitUrl` | `https://prod-XX.westus.logic.azure.com/...` | Power Automate HTTP trigger URL |
| `Webapi/ethi_ssirequestportal/enabled` | `true` | Enable Web API for file uploads |
| `Webapi/ethi_ssirequestportal/fields` | `ethi_uploadshipparticulars,ethi_existingssc` | Restrict to file columns only |

### Table Permissions

```
Name: SSI File Upload
Table: ethi_ssirequestportal
Scope: Global
Privileges: Update only
Web Role: Anonymous Users
Column Permissions: ethi_uploadshipparticulars, ethi_existingssc
```

### Web Files

| Name | Partial URL | Content Type |
|------|-------------|--------------|
| ssi-request.js | /ssi-request.js | application/javascript |
| ssi-request.css | /ssi-request.css | text/css |

### Web Pages (Bilingual Pair)

| Name | Partial URL | Language | Web Template |
|------|-------------|----------|--------------|
| SSI Request | /en/ssi-request/ | English | ssi-request-template |
| Demande SSI | /fr/demande-ssi/ | French | ssi-request-template |

---

## Power Automate Flow Specification

### Trigger

**HTTP trigger** (When a HTTP request is received)

### Request Schema

```json
{
  "type": "object",
  "properties": {
    "recaptchaToken": { "type": "string" },
    "ethi_nameofshippingagentcompany": { "type": "string" },
    "ethi_organizationphone": { "type": "string" },
    "ethi_organizationemail": { "type": "string" },
    "ethi_canadiancoastguard": { "type": "boolean" },
    "ethi_invoicecountry_guid": { "type": "string" },
    "ethi_invoiceprovince_guid": { "type": "string" },
    "ethi_flaginregistry_guid": { "type": "string" },
    "ethi_serviceprovince_guid": { "type": "string" },
    "ethi_nettonnage": { "type": "integer" },
    "... all other fields ...": {}
  }
}
```

### Flow Actions

1. **Verify reCAPTCHA** — HTTP POST to `https://www.google.com/recaptcha/api/siteverify`
   - Body: `secret=YOUR_SECRET&response=recaptchaToken`
   - If `score < 0.5` → Respond 403 `{ "error": "reCAPTCHA failed" }`

2. **Validate Payload** — Compose + Condition actions
   - Required: `ethi_nameofshippingagentcompany`, `ethi_organizationphone`, `ethi_organizationemail`
   - Lengths: all strings ≤ 100 chars (except `ethi_additionalcomments` ≤ 2000)
   - GUIDs: valid format `{8-4-4-4-12}` for lookup fields
   - Business rules: CCG=true → no invoice fields expected

3. **Create Dataverse Record** — "Add a new row" action
   - Lookup bindings: `_guid` suffixed fields → `/ethi_countries(guid)` format
   - Returns: record GUID

4. **Respond** — HTTP 200 with `{ "id": "guid-of-created-record" }`

### Response Codes

| Code | Body | Reason |
|------|------|--------|
| 200 | `{ "id": "guid" }` | Success |
| 400 | `{ "error": "Validation failed", "details": [...] }` | Invalid payload |
| 403 | `{ "error": "reCAPTCHA failed" }` | Bot detected (score < 0.5) |
| 500 | `{ "error": "Internal error" }` | Dataverse or flow failure |

---

## Entity & Field Reference

### Main Entity: `ethi_ssirequestportal`

**Plural:** `ethi_ssirequestportals`

| Step | Field | Type | Required | Validation | Notes |
|------|-------|------|----------|------------|-------|
| 1 | `ethi_nameofshippingagentcompany` | text(100) | ✅ | maxlength | |
| 1 | `ethi_firstnameofshippingagentrequestingservices` | text(100) | ❌ | maxlength | |
| 1 | `ethi_lastnameofshippingagentrequestingservices` | text(100) | ❌ | maxlength | |
| 1 | `ethi_organizationphone` | text(100) | ✅ | 10 digits | `type="tel"`, JS strips non-digits |
| 1 | `ethi_organizationphoneextension` | text(100) | ❌ | 1-6 digits | |
| 1 | `ethi_secondaryphone` | text(100) | ❌ | 10 digits | `type="tel"`, JS strips non-digits |
| 1 | `ethi_organizationemail` | text(100) | ✅ | email format | `type="email"` |
| 2 | `ethi_canadiancoastguard` | boolean | ✅ | radio | Drives invoice section visibility |
| 2 | `ethi_invoicingname` | text(100) | ✅* | maxlength | *Required when CCG=No |
| 2 | `ethi_invoicecountry` | lookup(ethi_country) | ✅* | — | fetchxml populated |
| 2 | `ethi_invoiceprovince` | lookup(ethi_province) | ✅* | — | Shown when Canada |
| 2 | `ethi_invoiceprovincestate` | text(100) | ✅* | maxlength | Shown when not Canada |
| 2 | `ethi_invoicecity` | text(100) | ✅* | maxlength | |
| 2 | `ethi_invoiceaddressline1` | text(100) | ✅* | maxlength | |
| 2 | `ethi_invoiceaddressline2` | text(100) | ❌ | maxlength | |
| 2 | `ethi_invoicepostalcode` | text(100) | ✅* | postalCodeCA | Shown when Canada |
| 2 | `ethi_invoicepostalcodezipcode` | text(20) | ✅* | maxlength | Shown when not Canada |
| 2 | `ethi_businessnumber` | text(100) | ❌ | 9 digits | |
| 2 | `ethi_isorganizationnumber` | text(100) | ❌ | maxlength | |
| 2 | `ethi_isreferencenumber` | text(100) | ❌ | maxlength | |
| 3 | `ethi_shipname` | text(100) | ✅ | maxlength | |
| 3 | `ethi_vesselname` | text(100) | ✅ | maxlength | |
| 3 | `ethi_imoregistrationnumber` | text(100) | ✅ | 7-8 digits | |
| 3 | `ethi_callsign` | text(100) | ✅ | maxlength | |
| 3 | `ethi_portofregistry` | text(100) | ✅ | maxlength | |
| 3 | `ethi_nettonnage` | integer | ✅ | 1-9999999 | |
| 3 | `ethi_numberofholds` | integer | ❌ | 0-9999999 | |
| 3 | `ethi_typeofcargo` | text(100) | ❌ | maxlength | |
| 3 | `ethi_shipowner` | text(100) | ✅ | maxlength | |
| 3 | `ethi_flaginregistry` | lookup(ethi_country) | ✅ | — | fetchxml populated |
| 3 | `ethi_otherregistryflag` | text(100) | ✅* | maxlength | *When Flag="Other" |
| 3 | `ethi_uploadshipparticulars` | file | ✅ | 4MB, PDF/JPG/PNG/GIF | Uploaded via PUT |
| 3 | `ethi_existingssc` | file | ❌ | 4MB, PDF/JPG/PNG/GIF | Uploaded via PUT |
| 4 | `ethi_serviceprovince` | lookup(ethi_province) | ✅ | — | fetchxml populated |
| 4 | `ethi_servicecityname` | text(100) | ✅ | maxlength | |
| 4 | `ethi_servicelocation` | text(100) | ✅ | maxlength | |
| 4 | `ethi_dock` | text(100) | ❌ | maxlength | |
| 4 | `ethi_vesselexpectedarrivaldate` | date | ❌ | ≤ departure | Cross-field JS validation |
| 4 | `ethi_vesselexpecteddeparturedate` | date | ❌ | — | |
| 4 | `ethi_previousportofcall` | text(100) | ✅ | maxlength | |
| 4 | `ethi_nextportofcall` | text(100) | ❌ | maxlength | |
| 4 | `ethi_certificatesexpiresdate` | date | ❌ | — | |
| 4 | `ethi_additionalcomments` | text(2000) | ❌ | maxlength | textarea |
| 5 | `ethi_submittimeutc` | text | auto | — | JS-generated timestamp |

### Lookup Tables

| Table | Key Column | EN Name | FR Name | Used In |
|-------|-----------|---------|---------|---------|
| `ethi_country` | `ethi_countryid` | `ethi_name` | `ethi_namefr` | Invoice Country, Flag in Registry |
| `ethi_province` | `ethi_provinceid` | `ethi_name` | `ethi_namefr` | Invoice Province, Service Province |

### Known GUIDs

| Entity | Name | GUID | Purpose |
|--------|------|------|---------|
| `ethi_country` | Canada | `f23dc860-6f39-ef11-a317-000d3af44283` | Country toggle (Province vs State) |
| `ethi_country` | Other | `f8fad702-0328-ef11-840a-000d3af40fa9` | Registry Flag toggle (Other text field) |

---

## Known Gaps & TODOs

1. **`YOUR_SITE_KEY`** — Replace with actual reCAPTCHA v3 site key in `ssi-request.js`
2. **Flow URL** — Create Power Automate flow, add URL to `SSI/FlowSubmitUrl` site setting
3. **Confirmation page** — Build web template for post-submit redirect
4. **File column names** — Verify `ethi_uploadshipparticulars` and `ethi_existingssc` exist in Dataverse
5. **Lookup entity/column names** — Verify `ethi_country.ethi_namefr` and `ethi_province.ethi_namefr` exist
6. **File upload scoping** — Consider adding record ownership verification (upload only to records created by the current flow call)
7. **Flow URL per environment** — DEV/STG/PROD will have different flow URLs (site settings handle this per environment)
8. **reCAPTCHA secret key** — Store in flow environment variable (not in site settings or client code)
9. **Session timeout** — Power Pages session timeout may affect long forms; consider warning users
10. **Print styling** — CSS includes `@media print` rules showing all steps; verify layout

---

## Testing Plan

### Phase 1: Deployment + Basic Function

1. Deploy web template as Web Template in Portal Management
2. Upload JS and CSS as Web Files
3. Create EN + FR Web Pages pointing to template
4. Verify fetchxml renders countries/provinces in correct language and sort order
5. Test step navigation (all 5 steps forward and backward)
6. Test conditional fields (CCG toggle, Country toggle, Registry Flag toggle)
7. Test wb-frmvld validation (required, email, pattern, postal code, maxlength)

### Phase 2: Language Toggle

1. Fill steps 1-3 on English page
2. Click "Français" language toggle
3. Verify: French page loads at Step 3
4. Verify: all text/select values preserved
5. Verify: radio buttons preserved (CCG, invoice section visibility)
6. Verify: country select shows correct French name for previously selected country
7. Verify: file inputs show re-select warning with previous filename
8. Verify: selecting a new file restores required attribute and clears warning
9. Toggle back to English — verify state preserved again

### Phase 3: Accessibility

1. **Keyboard-only:** Navigate entire form without mouse. Verify all fields reachable, focus visible, no traps.
2. **NVDA + Chrome:** Page title announced, step legends announced, error summaries read, form fields labeled.
3. **VoiceOver + Safari (macOS):** Rotor lists form controls, navigation logical, errors announced.
4. **VoiceOver + Safari (iOS):** Swipe navigation works, keyboard types correct (numeric for tel, email for email).
5. **axe DevTools:** Target 0 critical violations.
6. **Color contrast:** All text ≥ 4.5:1, UI components ≥ 3:1.

### Phase 4: End-to-End Submission

1. Complete all 5 steps with valid data
2. Submit → verify reCAPTCHA token generated
3. Verify Power Automate flow receives payload
4. Verify Dataverse record created with correct values
5. Verify lookup fields bound correctly (country, province, flag)
6. Verify file columns populated (ship particulars, existing SSC)
7. Verify redirect to confirmation page
8. Test error scenarios: flow down, invalid reCAPTCHA, network failure

### Phase 5: Cross-Browser + Responsive

1. Chrome, Edge, Firefox, Safari (latest) — desktop
2. Safari iOS, Chrome Android — mobile
3. 320px, 375px, 768px, 1366px viewports
4. Touch targets ≥ 44px on mobile (CSS provides min-height: 44px)

---

## Migration from Current Implementation

### Current Architecture (for comparison)

```
6 Web Pages (multistep, Power Pages form engine)
├── ~3,500 lines custom JavaScript
│   ├── ethiLibrary.js (accessibility framework)
│   ├── validators.js (validation engine)
│   ├── validations.js (field configurations)
│   ├── fileNativeBridge.js (file upload workarounds)
│   └── Step 1-5 custom JS files
├── MutationObserver workarounds for Power Pages interference
├── removeBasicFormAria() workarounds
├── Flag-based validation (data attributes to fight synchronous clearing)
└── Platform-specific timing (getATTiming, UniversalAnnounce)
```

### POC Architecture

```
1 Web Page (single page, WET-BOEW form)
├── ~900 lines JavaScript (including extensive documentation)
│   └── ssi-request.js (everything in one file)
├── Zero workarounds (no MutationObservers, no ARIA fixes)
├── wb-frmvld handles all standard validation
└── Power Automate flow for server-side security
```

### What Transfers, What Doesn't

| Current Component | POC Equivalent | Notes |
|-------------------|----------------|-------|
| ethiLibrary.js | Not needed | wb-frmvld provides accessible validation |
| validators.js | Not needed | wb-frmvld + HTML5 attributes |
| validations.js | Not needed | data-rule-* attributes in HTML |
| fileNativeBridge.js | `validateFiles()` (~30 lines) | Direct file input, no workarounds |
| MutationObservers | Not needed | No Power Pages interference to fight |
| removeBasicFormAria() | Not needed | No "basic form" generated |
| getATTiming() | Not needed | wb-frmvld handles SR timing |
| Step JS files × 5 | Single `ssi-request.js` | All logic consolidated |
| Dataverse direct POST | Power Automate flow | Better security |
| Client-side lookups | Liquid fetchxml | Better security + performance |
