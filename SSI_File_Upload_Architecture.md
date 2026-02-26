# SSI Request — File Upload Architecture (POC v2)

## Overview

The SSI Request has **two file columns** on `ethi_ssirequestportal`:

| Column | Dataverse Type | Required | Accepted Types | Max Size |
|--------|---------------|----------|----------------|----------|
| `ethi_uploadshipparticulars` | File | Yes | PDF, JPG, PNG, GIF | 4 MB |
| `ethi_existingssc` | File | No | PDF, JPG, PNG, GIF | 4 MB |

Unlike the GI Report (which has no file uploads), the SSI Request requires a **two-phase submission** because:
1. You cannot send binary files inside a JSON payload to a Power Automate HTTP trigger
2. Dataverse file columns require a separate PUT request per file — they cannot be set during record creation

---

## 1. Why Two Phases?

### The Constraint

Power Automate's "When an HTTP request is received" trigger accepts **JSON only**. There is no way to send `multipart/form-data` to it. Even if you base64-encode the file and include it in the JSON, the payload can easily exceed:

- Power Automate's HTTP trigger **1 MB** body limit (free/standard plans)
- Power Automate's **100 MB** body limit (premium, but still problematic for base64 overhead)
- The `ethi_uploadshipparticulars` file could be 4 MB raw → ~5.3 MB base64 → exceeds 1 MB trigger limit

### The Dataverse File Column Constraint

Dataverse "File" type columns (as opposed to "Image" columns or Note attachments) are uploaded via a dedicated REST endpoint:

```
PUT /_api/ethi_ssirequestportals({recordId})/ethi_uploadshipparticulars
Content-Type: application/octet-stream
x-ms-file-name: ship_particulars.pdf
Body: <raw binary>
```

This endpoint **only works on an existing record** — you cannot upload a file during record creation. The record must exist first, and then you update it with the file content.

### The Solution: Two-Phase Submit

**Phase 1:** Flow creates the record (JSON payload → Power Automate → Dataverse)
**Phase 2:** Client uploads files directly to the record's file columns via Web API PUT

---

## 2. Sequence Diagram

```
Browser                     Power Automate              Google              Dataverse
  │                              │                        │                    │
  ├─ 1. grecaptcha.execute() ───────────────────────────►│                    │
  │◄────── token ────────────────────────────────────────│                    │
  │                              │                        │                    │
  ├─ 2. POST { fields + token } ►│                        │                    │
  │                              ├─ 3. siteverify ───────►│                    │
  │                              │◄── { score } ─────────│                    │
  │                              │                        │                    │
  │                              ├─ 4. Log audit ────────────────────────────►│
  │                              │                                            │
  │                              ├─ 5. Evaluate score                         │
  │                              │   (score ≥ threshold?)                     │
  │                              │                                            │
  │                              ├─ 6. Validate payload                       │
  │                              │                                            │
  │                              ├─ 7. Create record ───────────────────────►│
  │                              │◄── { id: "guid" } ──────────────────────│
  │                              │                                            │
  │◄── 200 { id: "guid" } ──────┤                                            │
  │                              │                                            │
  │  ┌─────────────────────────────── PHASE 2: FILE UPLOADS ──────────────┐  │
  │  │                                                                     │  │
  │  │ 8. PUT /ethi_uploadshipparticulars ─────────────────────────────►│  │
  │  │    Content-Type: application/octet-stream                        │  │
  │  │    x-ms-file-name: ship_particulars.pdf                          │  │
  │  │    Body: <raw binary>                                            │  │
  │  │◄── 204 No Content ─────────────────────────────────────────────│  │
  │  │                                                                     │  │
  │  │ 9. PUT /ethi_existingssc (if file selected) ─────────────────►│  │
  │  │    Content-Type: application/octet-stream                        │  │
  │  │    x-ms-file-name: existing_ssc.pdf                              │  │
  │  │    Body: <raw binary>                                            │  │
  │  │◄── 204 No Content ─────────────────────────────────────────────│  │
  │  │                                                                     │  │
  │  └─────────────────────────────────────────────────────────────────────┘  │
  │                                                                           │
  ├─ 10. Redirect to confirmation page                                        │
  │                                                                           │
```

---

## 3. Phase 1: Record Creation (via Power Automate)

This is identical to the reCAPTCHA flow documented in `reCAPTCHA_Flow_Architecture.md`. The key points:

- Client sends **all form fields** (text, selects, radios, dates) as JSON
- reCAPTCHA token included in the payload
- Flow verifies token with Google, logs audit, evaluates score
- If score passes + payload validates → flow creates `ethi_ssirequestportal` record
- Flow returns `{ "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }`
- **No file data** in this payload — only field values

### What the Flow Creates

The flow's "Add a new row" action creates the record with all scalar fields populated. The two file columns are left empty — they'll be filled in Phase 2.

```json
{
  "ethi_nameofshippingagentcompany": "ABC Shipping",
  "ethi_organizationphone": "6135551234",
  "ethi_organizationemail": "contact@abc.com",
  "ethi_shipname": "MV Pacific Star",
  "ethi_uploadshipparticulars": null,   ← Empty, populated in Phase 2
  "ethi_existingssc": null              ← Empty, populated in Phase 2
}
```

---

## 4. Phase 2: File Upload (Direct to Dataverse Web API)

### The Web API Endpoint

Dataverse file columns have a dedicated upload endpoint:

```
PUT /_api/ethi_ssirequestportals({recordId})/{columnName}
```

### Request Format

```http
PUT /_api/ethi_ssirequestportals(a1b2c3d4-e5f6-7890-abcd-ef1234567890)/ethi_uploadshipparticulars
Content-Type: application/octet-stream
x-ms-file-name: ship_particulars.pdf
__RequestVerificationToken: <CSRF token from hidden input>

<raw binary content of the file>
```

### Key Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `application/octet-stream` | Raw binary upload |
| `x-ms-file-name` | URL-encoded filename | Dataverse uses this as the file name |
| `__RequestVerificationToken` | CSRF token from form | Power Pages CSRF protection |

### Response

- **204 No Content** — File uploaded successfully
- **403 Forbidden** — Table permission denied
- **413 Payload Too Large** — File exceeds Dataverse column limit
- **404 Not Found** — Record doesn't exist (or no Read permission)

### JavaScript Implementation

```javascript
function uploadFile(recordId, columnName, inputId) {
    var input = document.getElementById(inputId);
    if (!input || !input.files || !input.files[0]) return Promise.resolve();

    var file = input.files[0];
    log.info('Uploading: ' + file.name + ' → ' + columnName);

    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
            $.ajax({
                url: '/_api/ethi_ssirequestportals(' + recordId + ')/' + columnName,
                type: 'PUT',
                contentType: 'application/octet-stream',
                processData: false,
                headers: {
                    '__RequestVerificationToken': $('input[name="__RequestVerificationToken"]').val(),
                    'x-ms-file-name': encodeURIComponent(file.name)
                },
                data: reader.result   // ArrayBuffer — raw bytes
            }).then(resolve).fail(reject);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}
```

### Both Files Upload in Parallel

```javascript
// In handleSubmit(), after flow returns recordId:
return Promise.all([
    uploadFile(recordId, 'ethi_uploadshipparticulars', 'ethi_uploadshipparticulars'),
    uploadFile(recordId, 'ethi_existingssc', 'ethi_existingssc')
]);
```

`Promise.all` fires both uploads simultaneously. Since each file ≤ 4 MB, parallel upload saves time (one might finish while the other is still in flight).

---

## 5. Table Permissions for File Upload

### The Security Problem

In v2, the flow creates the record using a service account — **no anonymous Create permission** on the table. But the file upload goes directly from the browser to `/_api/` — this requires **some** anonymous permission.

### The Minimum Required Permission

| Scope | Permission | Column Restriction |
|-------|------------|-------------------|
| Global | **Update** | `ethi_uploadshipparticulars`, `ethi_existingssc` only |

This is done in Power Pages by creating a **Table Permission** record:

- **Table:** `ethi_ssirequestportal`
- **Scope:** Global
- **Permission:** Update only (not Create, not Read, not Delete)
- **Column Permissions:** Restrict to the two file columns only
- **Web Role:** Anonymous Users

### Why This is Safe

1. **No Create** — Attackers cannot create records via `/_api/`
2. **No Read** — Attackers cannot query or list records
3. **No Delete** — Attackers cannot delete records
4. **Column-restricted Update** — Attackers can only write to the two file columns
5. **Record must exist** — The PUT requires a valid record GUID (created by the flow)
6. **CSRF token required** — The `__RequestVerificationToken` header prevents cross-origin attacks

### Attack Surface Analysis

| Attack | Outcome |
|--------|---------|
| Upload file to non-existent record | 404 — record doesn't exist |
| Upload file to wrong column | 403 — only 2 columns allowed |
| Overwrite file on existing record | Possible IF attacker has GUID |
| Enumerate record GUIDs | Very difficult — GUIDs are random 128-bit |
| Upload file > 4 MB | Rejected by client-side validation + Dataverse column limit |
| Upload malicious file type | Client validates extension; Dataverse stores as-is (no execution) |

### Risk: GUID Guessing

If an attacker somehow obtains a valid record GUID (e.g., from browser console logs on a shared machine), they could overwrite the file columns. Mitigations:

1. **Short window** — Between record creation and file upload is typically < 5 seconds
2. **No Read permission** — Attacker can't verify if a GUID exists
3. **No API listing** — Attacker can't GET `/_api/ethi_ssirequestportals` to enumerate records
4. **Accept risk** — For a government form portal with no sensitive data in file uploads, this is an acceptable residual risk

---

## 6. Alternative Approaches Evaluated

### Option B: Route Files Through Flow (Rejected)

Instead of direct Web API upload, encode the file as base64 and send it to a second flow endpoint.

```
Browser → POST { recordId, base64File, fileName } → Flow → Upload to Dataverse
```

**Pros:**
- Zero anonymous table permissions (complete lockdown)
- Server-side file validation (size, type, virus scan potential)

**Cons:**
- Base64 encoding adds **33% overhead** (4 MB file → 5.3 MB payload)
- Power Automate HTTP trigger **1 MB body limit** on standard plans
- Power Automate "Respond to a PowerApp or flow" has **2 MB** response limit
- Flow execution adds **3-10 seconds** per file upload
- Requires Premium connector for HTTP trigger (already needed for Phase 1)
- Two serial flow executions for two files = **6-20 seconds** extra latency

**Verdict:** Rejected due to payload size limits and UX impact.

### Option C: Use Annotations/Notes Instead of File Columns (Rejected)

Store files as `annotation` records (notes with attachments) instead of file columns.

**Pros:**
- Well-established pattern in Dataverse
- Works with standard Web API
- No column-level permissions needed

**Cons:**
- Requires anonymous Create on `annotation` table (worse than Update on 2 columns)
- File is not directly on the record — harder to query in Power Automate
- Doesn't use the modern File column type
- Health Canada's data model already uses File columns

**Verdict:** Rejected — worse security posture and doesn't align with existing data model.

### Option D: Chunked Upload via Flow (Future Consideration)

For files > 4 MB or virus scanning requirements, implement chunked upload:

1. Client splits file into 1 MB chunks
2. Each chunk is base64-encoded and sent to a flow endpoint
3. Flow appends chunks to a blob storage location
4. After all chunks arrive, flow moves complete file to Dataverse

**Verdict:** Over-engineered for current 4 MB limit. Note for future if file size requirements increase.

---

## 7. Client-Side Validation

Validation runs **before** Phase 1 (on step 3, before navigating to step 4):

### File Validation Rules

```javascript
var FILE_MAX_BYTES = 4 * 1024 * 1024;  // 4 MB
var FILE_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif'];

function validateFiles() {
    if (currentStep !== 3) return true;
    var valid = true;

    var inputs = [
        { id: 'ethi_uploadshipparticulars', req: true },
        { id: 'ethi_existingssc', req: false }
    ];

    inputs.forEach(function (cfg) {
        var el = document.getElementById(cfg.id);
        var file = el.files && el.files[0];

        if (cfg.req && !file) return;  // wb-frmvld handles required

        if (file) {
            var ext = file.name.split('.').pop().toLowerCase();
            if (file.size === 0)                        → "File is empty"
            else if (file.size > FILE_MAX_BYTES)        → "File exceeds 4 MB"
            else if (FILE_ALLOWED_EXT.indexOf(ext) === -1) → "File type not accepted"
        }
    });
    return valid;
}
```

### Validation Matrix

| Check | Ship Particulars | Existing SSC | Timing |
|-------|-----------------|--------------|--------|
| Required | Yes | No | Step 3 → Step 4 |
| Max size (4 MB) | Yes | Yes | Step 3 → Step 4 |
| Allowed extension | Yes | Yes | Step 3 → Step 4 |
| Empty file (0 bytes) | Yes | Yes | Step 3 → Step 4 |

### Error Presentation (Accessible)

```javascript
function showFieldError($g, el, msg) {
    $g.addClass('has-error');
    var eid = el.id + '-file-error';
    $g.append(
        '<strong id="' + eid + '" class="file-error error">' +
        '<span class="label label-danger">' + msg + '</span></strong>'
    );
    el.setAttribute('aria-describedby', eid);
    el.setAttribute('aria-invalid', 'true');
}
```

- Error linked to input via `aria-describedby`
- `aria-invalid="true"` set on the input
- Visual error uses Bootstrap `.label-danger`
- Error text is bilingual (from `MSG` object)

---

## 8. Language Toggle and File Inputs

### The Problem

When the user clicks the EN/FR language toggle, the page navigates to the other-language URL. All form data is saved to `sessionStorage` and restored on the new page. **However, file inputs cannot be programmatically set** (browser security restriction).

### The Solution

```javascript
// SAVE (before language toggle navigation)
$('#ssi-request input[type="file"]').each(function () {
    if (this.files && this.files[0]) {
        state.files[this.id] = this.files[0].name;
    }
});

// RESTORE (on new page load)
Object.keys(state.files).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
        // Show warning with previous filename
        $group.append(
            '<p class="text-warning file-reselect-warning">' +
            'Previous file: <strong>' + state.files[id] + '</strong>' +
            ' — please re-select it.</p>'
        );

        // Temporarily remove required so user can navigate
        if (el.hasAttribute('required')) {
            el.removeAttribute('required');
            el.setAttribute('data-file-was-required', 'true');
        }
    }
});
```

### Re-Required on File Selection

```javascript
$('#ssi-request input[type="file"]').on('change', function () {
    if (this.getAttribute('data-file-was-required') === 'true') {
        this.setAttribute('required', 'required');
        this.removeAttribute('data-file-was-required');
    }
    $(this).closest('.form-group').find('.file-reselect-warning').remove();
});
```

### UX Flow After Language Toggle

1. User fills out steps 1-3 (including file upload)
2. User clicks "Français"
3. Form state saved to sessionStorage (including filenames)
4. Page navigates to `/fr/demande-ssi/`
5. Form state restored: all text/select fields populated, radios checked
6. File inputs show warning: "Fichier précédent : ship_particulars.pdf — veuillez le sélectionner à nouveau."
7. `required` temporarily removed from Ship Particulars file input
8. User re-selects the file → `required` restored, warning removed
9. User continues to step 4/5

---

## 9. Error Handling During File Upload

### Error Scenarios

| Scenario | Phase | Client Action | User Experience |
|----------|-------|---------------|-----------------|
| Flow returns 403 | Phase 1 | Show error alert, re-enable Submit | "An error occurred. Please try again." |
| Flow returns 200, file upload fails | Phase 2 | Show error alert, re-enable Submit | "An error occurred. Please try again." |
| File upload 413 (too large) | Phase 2 | Show error alert | Should not happen (client validates) |
| File upload 404 (record gone) | Phase 2 | Show error alert | Rare — record just created |
| File upload network error | Phase 2 | Show error alert, re-enable Submit | "An error occurred. Please try again." |
| File upload partial (1 of 2 succeeds) | Phase 2 | Show error alert | Record exists with one file |

### Partial Upload Recovery

If one file uploads successfully but the second fails, the record exists in Dataverse with one file column populated. The user will need to contact the SSI team to upload the missing file manually (or re-submit the entire form).

**Acceptable risk:** This is a rare edge case (network drops mid-upload) and the record data is preserved. The SSI team can see the record and follow up.

### Error Handler

```javascript
.catch(function (err) {
    log.error('Submit failed', err);
    $btnSubmit.prop('disabled', false).text(MSG.submitLabel);

    var $alert = $('<div class="alert alert-danger" role="alert">' +
                   '<p>' + MSG.submitError + '</p></div>');
    $('#review-summary').before($alert);
    $alert[0].setAttribute('tabindex', '-1');
    $alert[0].focus();  // SR announces via role="alert" + focus
    setTimeout(function () {
        $alert.fadeOut(function () { $alert.remove(); });
    }, 10000);
});
```

---

## 10. Timing and UX

### Typical Submit Timeline

```
Time    Action
0.0s    User clicks Submit
0.1s    Button disabled, text → "Submitting…"
0.2s    grecaptcha.execute() fires
0.5s    reCAPTCHA token received
0.6s    POST to Power Automate flow
1.0s    Flow verifies reCAPTCHA with Google
1.5s    Flow validates payload
2.0s    Flow creates Dataverse record
2.5s    Flow responds with { id: "guid" }
2.6s    File upload 1 starts (Ship Particulars, ~2 MB)
2.6s    File upload 2 starts (Existing SSC, ~1 MB)  ← parallel
4.0s    File upload 2 completes
5.5s    File upload 1 completes
5.6s    Redirect to confirmation page
```

**Total: ~5-6 seconds** for a typical submission with two files.

Without files (if Ship Particulars requirement is relaxed): ~2.5 seconds.

### Progress Feedback

The current implementation shows only "Submitting…" on the button. For better UX, consider a progress indicator:

```javascript
$btnSubmit.text(MSG.submitting);                    // Phase 1
// After flow returns:
$btnSubmit.text(IS_FR ? 'Téléversement...' : 'Uploading files...');  // Phase 2
// After uploads complete:
// → redirect
```

---

## 11. Power Pages Site Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `Webapi/ethi_ssirequestportal/enabled` | `true` | Enable Web API for file upload |
| `Webapi/ethi_ssirequestportal/fields` | `ethi_uploadshipparticulars,ethi_existingssc` | **Restrict** to file columns only |

**Critical:** The `fields` setting must restrict to **only the two file columns**. If set to `*`, the anonymous Update permission would allow writing to ALL columns — defeating the purpose of the flow-based architecture.

### Table Permission Configuration

| Setting | Value |
|---------|-------|
| Table Name | `ethi_ssirequestportal` |
| Scope | Global |
| Read | No |
| Create | No |
| Write (Update) | Yes |
| Delete | No |
| Append | No |
| Append To | No |
| Web Role | Anonymous Users |

### Column Permissions (optional, defense-in-depth)

If your Power Pages version supports column-level permissions:

| Column | Read | Update |
|--------|------|--------|
| `ethi_uploadshipparticulars` | No | Yes |
| `ethi_existingssc` | No | Yes |
| All other columns | No | No |

---

## 12. Testing Checklist

### Functional Tests

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Submit with both files (PDF, 1 MB each) | 200 → files uploaded → redirect |
| 2 | Submit with Ship Particulars only (no SSC) | 200 → 1 file uploaded → redirect |
| 3 | Submit with no files (validation) | Step 3 blocked — Ship Particulars required |
| 4 | Submit with oversized file (5 MB) | Step 3 blocked — "File exceeds 4 MB" |
| 5 | Submit with invalid type (.docx) | Step 3 blocked — "File type not accepted" |
| 6 | Submit with 0-byte file | Step 3 blocked — "File is empty" |
| 7 | Flow returns 403, no files uploaded | Error alert, no orphan record |
| 8 | Flow returns 200, file upload 403 | Error alert, record exists without files |
| 9 | Language toggle with files, re-select, submit | Files uploaded after re-selection |

### Accessibility Tests

| # | AT | Test | Expected |
|---|-----|------|----------|
| 1 | NVDA | Tab to file input | "Upload Ship Particulars, required, file upload button" |
| 2 | NVDA | Upload invalid file, trigger error | "File type not accepted" announced |
| 3 | VoiceOver | Double-tap file input | File picker opens |
| 4 | VoiceOver | File reselect warning after lang toggle | Warning text announced |
| 5 | TalkBack | Swipe to file input, double-tap | File picker opens |

### Browser Tests

| Browser | Phase 1 | Phase 2 | Notes |
|---------|---------|---------|-------|
| Chrome (Desktop) | ✓ | ✓ | Primary target |
| Edge (Desktop) | ✓ | ✓ | Primary target |
| Safari (macOS) | ✓ | ✓ | VoiceOver testing |
| Safari (iOS) | ✓ | ✓ | Mobile file picker |
| Chrome (Android) | ✓ | ✓ | Mobile file picker |

---

## 13. Comparison: GI Report vs SSI Request Submission

| Aspect | GI Report | SSI Request |
|--------|-----------|-------------|
| File uploads | None | 2 (Ship Particulars + SSC) |
| Submission phases | 1 | 2 |
| Anonymous permissions | Zero | Update-only on 2 file columns |
| Flow actions | 8 | 8 (same) |
| Client-side steps | 6 | 8 (add file reads + PUTs) |
| Total submit time | ~2.5s | ~5.5s |
| Error complexity | Simple | Higher (partial upload possible) |
| Language toggle impact | None (no files) | Must re-select files |

---

## Summary

The SSI file upload architecture uses a pragmatic two-phase approach that balances security with platform constraints. Phase 1 eliminates the biggest security risk (anonymous Create) by routing through Power Automate. Phase 2 uses a narrowly scoped Update-only permission on just two file columns — a much smaller attack surface than the v1 architecture where the entire table was exposed with Create + Read permissions.

The main trade-off is UX complexity: the user sees a slightly longer submit time (~5.5s vs ~2.5s for GI), and language toggle requires file re-selection. Both are acceptable for a government form portal that processes ~50-100 submissions per month.
