# SSI Request — Single Page POC Architecture (v2)

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `ssi-request-template.html` | 420 | Liquid web template (all 5 steps, fetchxml lookups) |
| `ssi-request.js` | 736 | Form controller (nav, validation, submit, language toggle) |
| `ssi-request.css` | 390 | GCWeb-compatible styling (unchanged from v1) |
| `SSI_POC_Architecture.md` | this file | Setup guide + architecture notes |
| **Total** | **~1,546** | |

### v1 → v2 Delta

| Change | v1 | v2 | Impact |
|--------|----|----|--------|
| Countries/Provinces | Client-side `/_api/` AJAX | Server-side `{% fetchxml %}` | -60 lines JS, zero Read permissions |
| Record creation | Direct `POST /_api/ethi_ssirequestportals` | Power Automate flow | Zero Create permissions |
| reCAPTCHA verify | Client-side POST to `hca_recaptchaattempts` | Flow verifies server-side | Zero table perms for reCAPTCHA |
| Language toggle | Full page reload, data lost | sessionStorage persist/restore | Seamless bilingual UX |
| JS size | 966 lines | 736 lines | -24% |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER                               │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           ssi-request-template.html               │   │
│  │  (Liquid renders: labels, fetchxml lookups,       │   │
│  │   bilingual text, reCAPTCHA key, flow URL)        │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ┌──────────▼───────────────────────────────────────┐   │
│  │              ssi-request.js                       │   │
│  │  showStep() → validate → buildPayload()           │   │
│  │  Language toggle → sessionStorage → restore       │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │                                            │
│  ╔══════════▼═══════════════════════════════════════╗   │
│  ║  wb-frmvld (WET validation framework)            ║   │
│  ║  Error summary, inline errors, aria-live         ║   │
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

## Data Flow

### Form Submission Sequence

1. User clicks **Submit** on Step 5
2. `executeRecaptcha()` → Google returns token
3. `buildPayload()` → JSON with all field values + `recaptchaToken`
4. `POST` to Power Automate flow URL
5. Flow verifies reCAPTCHA (score ≥ 0.5)
6. Flow validates payload (required fields, lengths, GUIDs)
7. Flow creates Dataverse record → returns `{ id: "guid" }`
8. JS uploads files via `PUT /_api/ethi_ssirequestportals({id})/columnName`
9. Redirect to confirmation page

### Language Toggle Sequence

1. User clicks language toggle link (`#wb-lng a`)
2. `initLanguageToggle()` intercepts click
3. Serialize all form data to `sessionStorage`:
   - Text/select/textarea values (by `id`)
   - Radio button checked values (by `name`)
   - File input names (cannot persist actual files)
4. Navigate to other-language URL (full page reload)
5. New page loads → Liquid renders correct language (labels, lookups)
6. `restoreFormState()` runs:
   - Restores radios first (drives CCG conditional sections)
   - 300ms delay for CSS transitions
   - Restores text/select values (GUIDs match across languages)
   - Shows file re-select warnings
   - Navigates to saved step

**Key insight:** Select option `value` attributes are Dataverse GUIDs — identical on both EN and FR pages. Setting `el.value = "f23dc860-..."` selects the correct option regardless of display language.

**File limitation:** Browser security prevents setting file input values. Users must re-select files after a language toggle. The UI shows a warning with the previous filename.

---

## Table Permissions (v2 — Minimal Surface)

| Table | Create | Read | Update | Notes |
|-------|--------|------|--------|-------|
| `ethi_ssirequestportal` | ❌ | ❌ | ✅ (file columns only) | Upload Ship Particulars + Existing SSC |
| `ethi_country` | ❌ | ❌ | ❌ | Rendered server-side via fetchxml |
| `ethi_province` | ❌ | ❌ | ❌ | Rendered server-side via fetchxml |
| `hca_recaptchaattempt` | ❌ | ❌ | ❌ | Flow handles reCAPTCHA verification |

**Total anonymous permissions:** 1 table, Update-only, 2 file columns only.

vs. v1: 4 tables, Create + Read on all.

---

## Power Pages Configuration Required

### Site Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `SSI/FlowSubmitUrl` | `https://prod-XX.westus.logic.azure.com/...` | Power Automate HTTP trigger URL |
| `Webapi/ethi_ssirequestportal/enabled` | `true` | File upload via Web API |
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

### Web Pages

| Name | Partial URL | Language | Web Template |
|------|-------------|----------|--------------|
| SSI Request | /en/ssi-request/ | English | ssi-request-template |
| Demande SSI | /fr/demande-ssi/ | French | ssi-request-template |

Both pages use the same web template. Language is detected via `webpage.adx_webpage_language.adx_languagecode`.

---

## Power Automate Flow Specification

### Trigger
**HTTP trigger** (When a HTTP request is received)

**Request Body Schema:**
```json
{
  "type": "object",
  "properties": {
    "recaptchaToken": { "type": "string" },
    "ethi_nameofshippingagentcompany": { "type": "string" },
    "ethi_organizationphone": { "type": "string" },
    "ethi_organizationemail": { "type": "string" },
    "ethi_canadiancoastguard": { "type": "boolean" },
    ...
  }
}
```

### Flow Steps

1. **Verify reCAPTCHA** — HTTP POST to `https://www.google.com/recaptcha/api/siteverify`
   - If score < 0.5 → respond 403 `{ "error": "reCAPTCHA failed" }`
2. **Validate payload** — Compose + Condition actions
   - Required fields present
   - String lengths within limits
   - GUIDs are valid format
   - Business rules (CCG=true → no invoice fields)
3. **Create Dataverse record** — Add a new row (ethi_ssirequestportal)
   - Lookup bindings: `/ethi_countries(guid)` for country, province, flag
4. **Respond** — 200 OK `{ "id": "guid-of-created-record" }`

### Error Responses

| Code | Body | Reason |
|------|------|--------|
| 200 | `{ "id": "guid" }` | Success |
| 400 | `{ "error": "Validation failed", "details": [...] }` | Invalid payload |
| 403 | `{ "error": "reCAPTCHA failed" }` | Bot detected |
| 500 | `{ "error": "Internal error" }` | Dataverse failure |

---

## What wb-frmvld Handles (Zero Custom Code)

- Required field validation (asterisk + `aria-required`)
- Error summary on submit (numbered list with anchor links)
- Inline error messages per field
- Screen reader announcements (`aria-live="polite"`)
- Email validation (`type="email"`)
- Postal code CA validation (`data-rule-postalCodeCA`)
- Pattern validation (`pattern` + `data-msg`)
- Max length validation (`data-rule-maxlength`)
- Hidden field exclusion (`.step-hidden` ignore selector)
- Bilingual message switching (auto on `<html lang>`)

## What Custom JS Handles

- Step show/hide + progress indicator
- CCG / Country / Registry Flag conditional logic
- File validation (size, type, empty)
- Date comparison (arrival ≤ departure)
- Phone digit stripping (`type="tel"` input event)
- Review summary generation
- Submit timestamp
- reCAPTCHA execution
- Flow submission + file upload
- Language toggle form state preservation
- Browser history API

---

## Known Gaps / TODOs

1. **`YOUR_SITE_KEY`** — Replace with actual reCAPTCHA v3 site key
2. **Flow URL** — Create Power Automate flow and add URL to `SSI/FlowSubmitUrl`
3. **Confirmation page** — Build web template for post-submit redirect
4. **File column names** — Verify `ethi_uploadshipparticulars` and `ethi_existingssc` match Dataverse
5. **Lookup entity names** — Verify `ethi_country`, `ethi_province` and their column names
6. **File upload scoping** — Consider adding record ownership check (flow returns ID, upload only to that ID)
7. **Flow URL per environment** — Different URLs for DEV/STG/PROD (site settings handle this)

---

## Testing Plan

### Phase 1: Local / DEV

1. Deploy web template, JS, CSS as web files
2. Create EN + FR web pages pointing to template
3. Verify fetchxml renders countries/provinces in correct language
4. Test step navigation (all 5 steps)
5. Test conditional fields (CCG, Country, Registry Flag)
6. Test wb-frmvld validation (required, email, pattern, postal code)
7. Test language toggle preservation:
   - Fill steps 1-3 on EN page
   - Click Français
   - Verify data restored on FR page at step 3
   - Verify file re-select warnings shown
   - Verify select values match (GUIDs)

### Phase 2: Accessibility

1. Keyboard-only navigation (no mouse)
2. NVDA + Chrome: step announcements, error summaries, form labels
3. VoiceOver + Safari (macOS): rotor, form controls
4. VoiceOver + Safari (iOS): swipe navigation, keyboard types
5. axe DevTools: 0 critical violations
6. Color contrast: ≥ 4.5:1 text, ≥ 3:1 UI components

### Phase 3: Cross-Browser + Responsive

1. Chrome, Edge, Firefox, Safari (latest)
2. Safari iOS, Chrome Android
3. 320px, 375px, 768px, 1366px viewports
4. Touch targets ≥ 44px on mobile

### Phase 4: End-to-End

1. Complete form → submit → verify Dataverse record
2. Upload files → verify file columns populated
3. reCAPTCHA flow → verify threshold enforcement
4. Error handling: flow down, invalid token, network failure
