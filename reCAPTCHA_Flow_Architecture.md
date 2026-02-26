# reCAPTCHA v3 — Flow-Based Verification (POC v2)

## Table of Contents

1. [Why the Architecture Changed](#1-why-the-architecture-changed)
2. [Current Architecture (v1) — What's Wrong](#2-current-architecture-v1)
3. [POC v2 Architecture — Flow-Based](#3-poc-v2-architecture)
4. [Detailed Sequence: Client Side](#4-client-side-sequence)
5. [Detailed Sequence: Power Automate Flow](#5-power-automate-flow-sequence)
6. [Flow Configuration Blueprint](#6-flow-configuration-blueprint)
7. [Google siteverify API Reference](#7-google-siteverify-api)
8. [Error Handling Matrix](#8-error-handling-matrix)
9. [Environment-Specific Configuration](#9-environment-configuration)
10. [Security Considerations](#10-security-considerations)
11. [Audit Trail Design](#11-audit-trail)
12. [Testing & Troubleshooting](#12-testing)

---

## 1. Why the Architecture Changed

The current reCAPTCHA implementation has three systemic problems that the POC v2 flow-based approach eliminates:

| Problem | v1 Impact | v2 Solution |
|---------|-----------|-------------|
| **Anonymous Create permission** on `hca_recaptchaattempts` | Attackers can flood the table with junk records | Flow creates records with service account — zero anonymous permissions |
| **Plugin throws on low scores** | Audit data lost (Dataverse rolls back on exception), no audit trail for rejected attempts | Flow stores audit data THEN evaluates score — all attempts logged |
| **Client evaluates threshold** | Threshold visible in JS, attackable | Flow evaluates server-side — client never sees threshold |

### The Core Principle

> **reCAPTCHA verification must happen where the attacker cannot observe or manipulate it.**

In v1, the client obtains a token, POSTs it to a Dataverse table, a plugin calls Google, and the client reads back the score. The score and threshold are both visible in the browser — an attacker can inspect and replay.

In v2, the client obtains a token and sends it to a Power Automate flow. The flow calls Google, evaluates the score against a secret threshold, and either creates the record or rejects the request. The client never sees the score.

---

## 2. Current Architecture (v1)

### Sequence Diagram

```
Browser                     Power Pages Web API       Dataverse Plugin        Google
   │                              │                       │                     │
   │  grecaptcha.execute()        │                       │                     │
   │ ─────────────────────────────┼───────────────────────┼────────────────────>│
   │  token (string, ~2400 chars) │                       │                     │
   │ <────────────────────────────┼───────────────────────┼─────────────────────│
   │                              │                       │                     │
   │  POST /_api/hca_recaptcha    │                       │                     │
   │     { hca_token: "..." }     │                       │                     │
   │ ────────────────────────────>│                       │                     │
   │                              │  Create record        │                     │
   │                              │ ─────────────────────>│                     │
   │                              │                       │  POST siteverify    │
   │                              │                       │ ───────────────────>│
   │                              │                       │  { score: 0.7 }     │
   │                              │                       │ <───────────────────│
   │                              │                       │                     │
   │                              │                  ┌────┤                     │
   │                              │                  │ IF score < 0.5:         │
   │                              │                  │   throw Exception ❌    │
   │                              │                  │   (record rolled back)  │
   │                              │                  │ ELSE:                   │
   │                              │                  │   store score ✅        │
   │                              │                  └────┤                     │
   │                              │                       │                     │
   │  201 + { hca_score: 0.7 }    │                       │                     │
   │ <────────────────────────────│                       │                     │
   │                              │                       │                     │
   │  JS evaluates:               │                       │                     │
   │  score >= threshold?          │                       │                     │
   │  (threshold visible in JS!)  │                       │                     │
   │                              │                       │                     │
```

### v1 Problems in Detail

**Problem 1: Anonymous Create on hca_recaptchaattempts**

Any anonymous user (including attackers) can:
```
POST /_api/hca_recaptchaattempts
{ "hca_token": "anything", "hca_score": 99 }
```
The table permission grants Create to Anonymous Users. The only protection is the plugin, but the plugin can be bypassed by crafting requests that don't trigger it.

**Problem 2: Plugin throws exception → audit data lost**

When the Dataverse plugin (`RecaptchaVerification.VerifyRecaptchaPlugin`) calls Google siteverify and gets a low score, it throws `InvalidPluginExecutionException` with code `0x80040265` (IsvAborted). Dataverse then rolls back the entire CREATE operation — the audit record is never saved. This means:
- No record of failed reCAPTCHA attempts
- No way to detect bot patterns
- No audit trail for security review

**Problem 3: Client-side threshold evaluation**

The JavaScript reads the score back from Dataverse and compares it against a threshold:
```javascript
threshold = recaptchaGetThreshold();  // Reads from site settings or defaults to 0.5
var pass = results.hca_verified && results.hca_score >= threshold;
```
An attacker can see this threshold in DevTools and understand exactly what score they need. They can also modify the JS to skip the check entirely.

**Problem 4: Token length issues**

reCAPTCHA tokens are ~2400 characters. The `hca_token` column was originally 2048 characters, causing silent truncation that made the plugin's Google verification fail. This required manual column length changes across all environments.

---

## 3. POC v2 Architecture

### Sequence Diagram

```
Browser                    Power Automate Flow              Google            Dataverse
   │                              │                           │                  │
   │  grecaptcha.execute()        │                           │                  │
   │ ─────────────────────────────┼───────────────────────────┼──────────────>   │
   │  token (string)              │                           │                  │
   │ <────────────────────────────┼───────────────────────────┼──────────────    │
   │                              │                           │                  │
   │  POST to flow URL            │                           │                  │
   │  {                           │                           │                  │
   │    recaptchaToken: "...",    │                           │                  │
   │    ethi_vesselname: "...",   │                           │                  │
   │    ethi_captainsname: "...", │                           │                  │
   │    ...all form fields        │                           │                  │
   │  }                           │                           │                  │
   │ ────────────────────────────>│                           │                  │
   │                              │                           │                  │
   │                              │  POST siteverify          │                  │
   │                              │  { secret, token }        │                  │
   │                              │ ─────────────────────────>│                  │
   │                              │  { success, score, ... }  │                  │
   │                              │ <─────────────────────────│                  │
   │                              │                           │                  │
   │                              │  IF score < threshold:    │                  │
   │                              │    Return 403 ───────────────────────────>   │
   │                              │    (STILL log attempt)    │               (audit)
   │                              │                           │                  │
   │                              │  IF score >= threshold:   │                  │
   │                              │    Validate payload       │                  │
   │                              │    Create record ─────────────────────────>  │
   │                              │                           │              (record)
   │                              │    Return 200             │                  │
   │                              │    { id: "guid" }         │                  │
   │                              │                           │                  │
   │  200 OK / 403 Forbidden      │                           │                  │
   │ <────────────────────────────│                           │                  │
   │                              │                           │                  │
   │  200 → redirect to confirm   │                           │                  │
   │  403 → show error alert      │                           │                  │
   │  (client NEVER sees score)   │                           │                  │
```

### What Changed

| Aspect | v1 | v2 |
|--------|----|----|
| Token destination | `/_api/hca_recaptchaattempts` (Dataverse table) | Power Automate HTTP trigger URL |
| Who calls Google | Dataverse plugin (C#) | Power Automate HTTP action |
| Who evaluates score | Both plugin AND client JS | Flow only (server-side) |
| Who creates record | Client via Web API + plugin | Flow with service account |
| Score visible to client | Yes (returned in API response) | No (only 200/403) |
| Threshold visible to client | Yes (in JS / site settings) | No (in flow env variable) |
| Anonymous table permissions | Create on `hca_recaptchaattempts` | None |
| Failed attempts logged | No (plugin throws, rolls back) | Yes (flow logs before evaluating) |

---

## 4. Client-Side Sequence

### Step-by-Step (from gi-report.js / ssi-request.js)

**Step 1: User clicks Submit on Step 5**

```javascript
form.addEventListener('submit', function (e) {
  e.preventDefault();
  if (validateCurrentStep()) handleSubmit();
});
```

Validation passes → `handleSubmit()` executes.

**Step 2: Disable button, show spinner**

```javascript
function handleSubmit() {
  $btnSubmit.prop('disabled', true).text(MSG.submitting);
  // "Submitting…" / "Soumission en cours…"
```

Prevents double-submission. Button text changes to indicate processing.

**Step 3: Execute reCAPTCHA v3**

```javascript
  executeRecaptcha()
    .then(function (token) {
```

`executeRecaptcha()` calls:
```javascript
function executeRecaptcha() {
  return new Promise(function (resolve) {
    if (!window.grecaptcha) {
      log.warn('reCAPTCHA not loaded');
      resolve(null);
      return;
    }
    grecaptcha.ready(function () {
      grecaptcha.execute('YOUR_SITE_KEY', { action: 'gi_submit' })
        .then(resolve)
        .catch(function () { resolve(null); });
    });
  });
}
```

Key details:
- **Invisible**: No user interaction. reCAPTCHA v3 runs entirely in the background.
- **Action name**: `'gi_submit'` (or `'ssi_submit'` for SSI). Google uses this to build per-action analytics.
- **Returns a token**: ~2400 character string, valid for 2 minutes.
- **Graceful fallback**: If reCAPTCHA fails to load (blocked by ad blocker, network issue), resolves `null`. The flow can decide how to handle a missing token.

**Step 4: Build payload with token**

```javascript
      var payload = buildPayload();
      payload.recaptchaToken = token || '';
```

The token is added to the same JSON payload as all form fields. Single POST, not two separate requests.

**Step 5: POST to Power Automate flow**

```javascript
      return $.ajax({
        url: FLOW_URL,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(payload)
      });
```

- **FLOW_URL**: Injected by Liquid from site setting `GI/FlowSubmitUrl`
- **No CSRF token needed**: Flow URL is external (not Power Pages Web API)
- **No table permissions needed**: Not calling `/_api/` at all

**Step 6: Handle response**

```javascript
    .then(function (response) {
      // 200 OK — record created
      var recordId = response.id;
      log.info('Record: ' + recordId);
      
      // For SSI only: upload files here
      // For GI: no files, skip directly to redirect
      
      window.location.href = CONFIRM_URL;
    })
    .catch(function (err) {
      // 403 = reCAPTCHA failed
      // 400 = validation failed
      // 500 = flow/Dataverse error
      
      $btnSubmit.prop('disabled', false).text(MSG.submitLabel);
      
      var $alert = $('<div class="alert alert-danger" role="alert"><p>' + 
                     MSG.submitError + '</p></div>');
      $('#review-summary').before($alert);
      $alert[0].setAttribute('tabindex', '-1');
      $alert[0].focus();  // SR announces the error
      
      setTimeout(function () { 
        $alert.fadeOut(function () { $alert.remove(); }); 
      }, 10000);
    });
```

The client **never sees the score**. It only knows:
- **200**: Success → redirect
- **403**: Bot detected → show error (no details about score)
- **400**: Validation error → show error
- **500**: Internal error → show error

---

## 5. Power Automate Flow Sequence

### Flow Trigger

**Type**: "When an HTTP request is received"  
**Method**: POST  
**Request Body JSON Schema**: (auto-generated from payload)

The flow URL looks like:
```
https://prod-XX.canadacentral.logic.azure.com:443/workflows/[workflow-id]/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=[signature]
```

The signature in the URL provides authentication — only requests with the correct URL can trigger the flow. The URL is stored in a site setting (not in client-side JS directly) and injected by Liquid.

### Flow Actions (Detailed)

#### Action 1: Parse JSON (trigger body)

```
Parse JSON
  Content: @{triggerBody()}
  Schema: { ... full payload schema ... }
```

This makes all form fields available as dynamic content in subsequent actions.

#### Action 2: Verify reCAPTCHA with Google

```
HTTP
  Method: POST
  URI: https://www.google.com/recaptcha/api/siteverify
  Headers:
    Content-Type: application/x-www-form-urlencoded
  Body: secret=@{variables('RECAPTCHA_SECRET')}&response=@{body('Parse_JSON')?['recaptchaToken']}
```

**Why `application/x-www-form-urlencoded`**: Google's siteverify endpoint requires form-encoded POST, not JSON. This is a common gotcha.

**The secret key** is stored in a flow Environment Variable (`RECAPTCHA_SECRET`), not in the flow definition itself. This means:
- Different secrets per environment (DEV/STG/PROD)
- Secret not visible in flow designer to non-admins
- Secret not in source control

#### Action 3: Parse Google Response

```
Parse JSON
  Content: @{body('Verify_reCAPTCHA')}
  Schema:
  {
    "type": "object",
    "properties": {
      "success": { "type": "boolean" },
      "score": { "type": "number" },
      "action": { "type": "string" },
      "challenge_ts": { "type": "string" },
      "hostname": { "type": "string" },
      "error-codes": { "type": "array" }
    }
  }
```

#### Action 4: Log Audit Record (ALWAYS — before score evaluation)

```
Dataverse: Add a new row
  Table: hca_recaptchaattempts
  Fields:
    hca_token: @{body('Parse_JSON')?['recaptchaToken']}  (truncated to 4000)
    hca_score: @{body('Parse_Google_Response')?['score']}
    hca_verified: @{body('Parse_Google_Response')?['success']}
    hca_action: @{body('Parse_Google_Response')?['action']}
    hca_hostname: @{body('Parse_Google_Response')?['hostname']}
    hca_passed: @{if(body('Parse_Google_Response')?['score'] >= variables('SCORE_THRESHOLD'), true, false)}
    hca_timestamp: @{utcNow()}
    hca_portal: 'GI' (or 'SSI')
```

**Critical**: This runs BEFORE the score evaluation condition. Every attempt is logged, whether it passes or fails. This solves the v1 audit gap where failed attempts were rolled back.

#### Action 5: Evaluate Score (Condition)

```
Condition
  @{body('Parse_Google_Response')?['score']} >= @{variables('SCORE_THRESHOLD')}
  AND
  @{body('Parse_Google_Response')?['success']} equals true
```

**If No (bot detected):**

```
Response
  Status Code: 403
  Body: {
    "error": "reCAPTCHA verification failed",
    "code": "RECAPTCHA_FAILED"
  }
```

The flow STOPS here. No record is created. But the audit record from Action 4 is already saved.

**If Yes (human detected):**

Continue to Action 6.

#### Action 6: Validate Payload

```
Condition (series of checks)
  - ethi_cruiselinename is not empty AND length <= 100
  - ethi_vesselname is not empty AND length <= 100
  - ethi_captainsemailaddress matches email pattern
  - ethi_shipphonenumber matches /^[0-9]{10}$/
  - ethi_embarkationdate <= ethi_disembarkationdate
  - ethi_reporttype IN (992800000, 992800001, 992800002)
  - (... all required fields present ...)
```

**If validation fails:**
```
Response
  Status Code: 400
  Body: {
    "error": "Validation failed",
    "details": ["ethi_vesselname is required", "..."]
  }
```

#### Action 7: Create Dataverse Record

```
Dataverse: Add a new row
  Table: ethi_gireport
  Fields:
    ethi_cruiselinename: @{body('Parse_JSON')?['ethi_cruiselinename']}
    ethi_vesselname: @{body('Parse_JSON')?['ethi_vesselname']}
    ...
    
    // Lookup field (OData bind syntax):
    ethi_nextport@odata.bind: /ethi_servicelocations(@{body('Parse_JSON')?['ethi_nextport_guid']})
    
    // Boolean:
    ethi_submitterismedicalcontact: @{body('Parse_JSON')?['ethi_submitterismedicalcontact']}
    
    // Integer:
    ethi_totalnumberofpassengersonboard: @{body('Parse_JSON')?['ethi_totalnumberofpassengersonboard']}
    
    // Computed:
    ethi_nextcanadadateandtimeportal: @{body('Parse_JSON')?['ethi_nextcanadadateandtimeportal']}
    
    // System:
    ethi_submittimeutc: @{body('Parse_JSON')?['ethi_submittimeutc']}
```

The flow runs with the **connection owner's privileges** (a service account), not anonymous user permissions. This is why zero table permissions are needed for anonymous users.

#### Action 8: Respond to Client

```
Response
  Status Code: 200
  Headers:
    Content-Type: application/json
  Body: {
    "id": "@{outputs('Create_Dataverse_Record')?['body/ethi_gireportid']}",
    "name": "@{outputs('Create_Dataverse_Record')?['body/ethi_name']}"
  }
```

The client receives only the record ID (for SSI file uploads) and the reference number (for confirmation display). No score, no threshold, no audit data.

---

## 6. Flow Configuration Blueprint

### Environment Variables

| Variable | DEV | STG | PROD | Purpose |
|----------|-----|-----|------|---------|
| `RECAPTCHA_SECRET` | `6Lxx...DEV` | `6Lxx...STG` | `6Lxx...PROD` | Google secret key (paired with site key) |
| `SCORE_THRESHOLD` | `0.2` | `0.3` | `0.5` | Minimum score to pass |
| `AUDIT_ENABLED` | `true` | `true` | `true` | Whether to log attempts |

### Site Keys (Client-Side, per Environment)

Stored in the `<script>` tag loading reCAPTCHA, or in a site setting:

| Environment | Domain | Site Key |
|-------------|--------|----------|
| DEV | `safeport-dev-public-hc-sc.powerappsportals.com` | `6Lxx...DEV-public` |
| STG | `safeport-stg-public-hc-sc.powerappsportals.com` | `6Lxx...STG-public` |
| PROD | `safeport.hc-sc.gc.ca` | `6Lxx...PROD-public` |

**Critical**: Site key + secret key must be paired. A site key from DEV used with a secret from PROD will cause Google to return `success: false`.

### Flow Connection

The Dataverse connection in the flow should use a **service account**, not a personal account:
- Service account: `svc-safeport-flow@health.gc.ca` (example)
- Permissions: Create on `ethi_gireport`, Create on `hca_recaptchaattempts`
- This is a server-side permission, not an anonymous user permission

---

## 7. Google siteverify API Reference

### Request

```
POST https://www.google.com/recaptcha/api/siteverify
Content-Type: application/x-www-form-urlencoded

secret=YOUR_SECRET_KEY&response=USER_TOKEN
```

### Response

```json
{
  "success": true,
  "score": 0.7,
  "action": "gi_submit",
  "challenge_ts": "2026-02-26T04:30:00Z",
  "hostname": "safeport-dev-public-hc-sc.powerappsportals.com",
  "error-codes": []
}
```

### Score Interpretation

| Score | Meaning | Action |
|-------|---------|--------|
| 0.9 – 1.0 | Very likely human | Allow |
| 0.7 – 0.9 | Probably human | Allow |
| 0.5 – 0.7 | Uncertain | Allow (default threshold) |
| 0.3 – 0.5 | Suspicious | Allow in DEV, block in PROD |
| 0.0 – 0.3 | Likely bot | Block |

### Common Error Codes

| Error | Meaning | Flow Handling |
|-------|---------|---------------|
| `missing-input-secret` | Secret key missing | Log + return 500 |
| `invalid-input-secret` | Secret key wrong | Log + return 500 (config error) |
| `missing-input-response` | Token missing | Log + return 403 |
| `invalid-input-response` | Token malformed/expired | Log + return 403 |
| `timeout-or-duplicate` | Token already used or > 2 min old | Log + return 403 |
| `bad-request` | Request malformed | Log + return 500 |

### Token Characteristics

- Length: ~2300–2500 characters (varies)
- Valid for: **2 minutes** after generation
- Single-use: Cannot be verified twice (Google returns `timeout-or-duplicate`)
- Tied to: Site key + domain + user's browser session

---

## 8. Error Handling Matrix

### Client-Side (JS)

| Flow Response | HTTP Code | Client Action | User Experience |
|--------------|-----------|---------------|-----------------|
| Success | 200 | Redirect to confirmation | "Thank you" page |
| reCAPTCHA failed | 403 | Show error alert | "An error occurred. Please try again." |
| Validation failed | 400 | Show error alert | "An error occurred. Please try again." |
| Flow/Dataverse error | 500 | Show error alert | "An error occurred. Please try again." |
| Network error | 0 | Show error alert | "An error occurred. Please try again." |
| reCAPTCHA not loaded | N/A | Send null token | Flow decides (reject or allow) |

Note: The client shows the same generic error for 400/403/500. This is intentional — we don't want to tell an attacker WHY their request failed.

### Flow-Side

| Scenario | Log Audit? | Create Record? | Response |
|----------|-----------|----------------|----------|
| Score ≥ threshold, valid payload | Yes | Yes | 200 + { id } |
| Score ≥ threshold, invalid payload | Yes | No | 400 + { details } |
| Score < threshold | Yes | No | 403 |
| Google returns success: false | Yes | No | 403 |
| Google unreachable | Yes (with error) | No | 500 |
| Token missing/null | Yes | No | 403 |
| Invalid JSON payload | No (can't parse) | No | 400 |

### Accessibility of Error States

```javascript
// Error alert is focusable and announced by screen readers
var $alert = $('<div class="alert alert-danger" role="alert"><p>' + MSG.submitError + '</p></div>');
$alert[0].setAttribute('tabindex', '-1');
$alert[0].focus();  // SR announces immediately via role="alert" + focus
```

- `role="alert"` triggers immediate announcement in NVDA/JAWS
- `tabindex="-1"` + `.focus()` ensures VoiceOver also announces
- Auto-dismiss after 10 seconds (not abrupt — uses fadeOut)
- Submit button re-enabled (user can retry)

---

## 9. Environment Configuration

### Google reCAPTCHA Admin Console Setup

For each environment, register a separate site key pair:

1. Go to https://www.google.com/recaptcha/admin
2. Click "+" to add a new site
3. Label: "SafePort DEV" (or STG, PROD)
4. reCAPTCHA type: **Score based (v3)**
5. Domains: `safeport-dev-public-hc-sc.powerappsportals.com`
6. Accept terms → Submit
7. Copy **Site Key** (public) and **Secret Key** (private)

### Power Automate Flow Per Environment

Each environment needs its own flow instance (or a single flow with environment-aware variables):

**Option A: Separate flows per environment**
- DEV flow URL → site setting `GI/FlowSubmitUrl` in DEV
- STG flow URL → site setting `GI/FlowSubmitUrl` in STG
- PROD flow URL → site setting `GI/FlowSubmitUrl` in PROD

**Option B: Single flow with environment variables**
- One flow checks `RECAPTCHA_SECRET` and `SCORE_THRESHOLD` from Environment Variables
- Same flow URL across environments
- Variables differ per environment

Option A is simpler and recommended for government deployments (clear separation).

### reCAPTCHA Script Loading

In the template, load reCAPTCHA v3 with the environment-appropriate site key:

```html
<!-- Option 1: Hardcoded (simplest for POC) -->
<script src="https://www.google.com/recaptcha/api.js?render=YOUR_SITE_KEY"></script>

<!-- Option 2: From site setting (production) -->
<script src="https://www.google.com/recaptcha/api.js?render={{ sitesettings['GI/RecaptchaSiteKey'] }}"></script>
```

And in the JS:
```javascript
// Option 1: Hardcoded
grecaptcha.execute('YOUR_SITE_KEY', { action: 'gi_submit' })

// Option 2: From config
grecaptcha.execute(CFG.recaptchaSiteKey, { action: 'gi_submit' })
```

---

## 10. Security Considerations

### What an attacker sees (v2)

1. The flow URL (in HTML source via Liquid injection)
2. The reCAPTCHA site key (in `<script>` tag)
3. The JS payload structure (in gi-report.js)

### What an attacker CANNOT see (v2)

1. The reCAPTCHA secret key (in flow environment variable)
2. The score threshold (in flow environment variable)
3. Their score (flow returns only 200/403)
4. The audit record (no Read permission on hca_recaptchaattempts)
5. The Dataverse record (no Read permission on ethi_gireport)

### Attack scenarios

| Attack | v1 Outcome | v2 Outcome |
|--------|------------|------------|
| Replay token | Plugin may accept (if not checking `timeout-or-duplicate`) | Google returns `timeout-or-duplicate` → flow rejects |
| Fake token | Plugin calls Google → fails | Flow calls Google → fails |
| Skip reCAPTCHA | Token = null → JS still posts to Dataverse with no token | Token = null → flow rejects (403) |
| Flood requests | Creates junk records in `hca_recaptchaattempts` | Flow rate-limited by Power Automate + no records created |
| Inspect threshold | Visible in JS / site settings | Not visible (server-side only) |
| Modify JS to skip check | Works — score check is client-side | Irrelevant — server evaluates score |

### Flow URL Protection

The flow URL contains a cryptographic signature (`sig=...`). This is not a public endpoint — it requires the exact URL with signature. However:

- The URL is in the HTML source (injected by Liquid)
- An attacker could extract it and call it directly

**Mitigation**: The flow still requires a valid reCAPTCHA token. Direct API calls without a valid token from the correct domain will get `success: false` from Google.

**Additional mitigation** (optional):
- Rate limiting in the flow (check IP, limit to N requests per hour)
- Validate the `hostname` in Google's response matches the portal domain
- Validate the `action` matches expected action name

---

## 11. Audit Trail Design

### hca_recaptchaattempts Table (Enhanced for v2)

| Column | Type | Description |
|--------|------|-------------|
| hca_recaptchaattemptid | GUID | Primary key |
| hca_token | Text(4000) | The reCAPTCHA token (for debugging) |
| hca_score | Decimal | Google's score (0.0 – 1.0) |
| hca_verified | Boolean | Google's `success` field |
| hca_passed | Boolean | score ≥ threshold (computed by flow) |
| hca_action | Text(50) | Google's `action` field (e.g., "gi_submit") |
| hca_hostname | Text(200) | Google's `hostname` field |
| hca_threshold | Decimal | The threshold used for evaluation |
| hca_portal | Text(10) | "GI" or "SSI" |
| hca_timestamp | DateTime | When the attempt occurred |
| hca_errorcodes | Text(500) | Google's `error-codes` (if any) |
| hca_recordcreated | Boolean | Whether the main record was created |
| hca_recordid | Text(50) | GUID of created record (if successful) |

### Audit Queries (for security review)

**Failed attempts in last 24 hours:**
```
Filter: hca_passed = false AND hca_timestamp >= [24h ago]
Sort: hca_timestamp desc
```

**Score distribution:**
```
Group by: ROUND(hca_score, 1)
Count: hca_recaptchaattemptid
```

**Suspicious patterns (same score repeatedly):**
```
Filter: hca_score = 0.1 AND hca_timestamp >= [1h ago]
Count > 10 → possible bot farm
```

---

## 12. Testing & Troubleshooting

### Testing reCAPTCHA in Development

**Problem**: DEV environments score lower because:
- VPN/proxy (government networks)
- Private/incognito browsers
- Automated testing tools
- New browser profiles (no Google history)

**Solution**: Lower threshold to 0.2 in DEV:
```
Environment Variable: SCORE_THRESHOLD = 0.2
```

### Test Scenarios

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Normal submission, good score | 200 → redirect to confirmation |
| 2 | Normal submission, low score (VPN) | 403 → error alert, re-enable button |
| 3 | reCAPTCHA blocked by ad blocker | Token = null → 403 (or allow with flag) |
| 4 | Token expired (user waited > 2 min on review) | Google returns error → 403 |
| 5 | Invalid flow URL | Network error → error alert |
| 6 | Flow down | 500 → error alert |
| 7 | Dataverse down | 500 → error alert |
| 8 | Replay same token twice | Second attempt: `timeout-or-duplicate` → 403 |

### Debugging Checklist

| Issue | Check |
|-------|-------|
| "An error occurred" on submit | Browser DevTools → Network tab → check flow response code and body |
| 403 consistently | Lower threshold in flow env variable. Check site key / secret key pairing. |
| 500 from flow | Power Automate → flow run history → check which action failed |
| Token = null | Check if reCAPTCHA script loaded (Network tab). Check for ad blockers. |
| Score = 0.1 always | Verify site key matches domain. Check `hostname` in Google response. |
| Flow URL not working | Verify site setting `GI/FlowSubmitUrl` is correct and the flow is turned on. |

### Console Logging (Client-Side)

```
[GI-v2] === Submit ===
[GI-v2] [DBG] Payload { ethi_cruiselinename: "...", recaptchaToken: "03AG...", ... }
[GI-v2] Record: a1b2c3d4-...
[GI-v2] === Complete ===
```

Or on error:
```
[GI-v2] === Submit ===
[GI-v2] Submit failed { status: 403, responseText: '{"error":"reCAPTCHA verification failed"}' }
```

---

*End of Document*
