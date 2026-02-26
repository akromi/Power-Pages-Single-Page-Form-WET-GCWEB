// ============================================================================
// SSI REQUEST — SINGLE PAGE FORM CONTROLLER (v2)
// ============================================================================
//
// FILE:         ssi-request.js
// TYPE:         Client-side form controller
// LAST UPDATED: 2026-02-25
//
// ============================================================================
// PURPOSE
// ============================================================================
//
// This script manages the entire lifecycle of the SSI Request single-page
// form: step navigation, conditional field logic, validation, language toggle
// state preservation, review summary generation, and submission to a Power
// Automate flow with subsequent file uploads to Dataverse.
//
// ============================================================================
// ARCHITECTURE
// ============================================================================
//
// The form exists as 5 <fieldset> elements in the DOM. Only one is visible
// at a time (controlled by the .step-hidden CSS class). This approach:
//
//   1. Eliminates Power Pages' native multistep engine interference
//   2. Keeps all form data in the DOM (no session state management)
//   3. Enables instant step transitions (no network round-trips)
//   4. Allows wb-frmvld to validate only the visible step via its
//      "ignore" selector that excludes .step-hidden elements
//
// ============================================================================
// SUBMISSION FLOW
// ============================================================================
//
//   1. User clicks Submit on Step 5
//   2. executeRecaptcha() → Google returns reCAPTCHA v3 token
//   3. buildPayload() → JSON object with all field values
//   4. POST payload + token to Power Automate flow URL
//   5. Flow validates reCAPTCHA (score ≥ 0.5), validates payload,
//      creates Dataverse record, returns { id: "guid" }
//   6. uploadFile() × 2 → PUT binary to Dataverse file columns
//   7. Redirect to confirmation page
//
// ============================================================================
// LANGUAGE TOGGLE PRESERVATION
// ============================================================================
//
// When a user clicks the WET language toggle (#wb-lng a), Power Pages
// navigates to the paired Web Page (full page reload). Without intervention,
// all form data would be lost.
//
// This script intercepts the toggle click, serializes all form state to
// sessionStorage, then lets the navigation proceed. On the target page,
// restoreFormState() reads sessionStorage and replays the values.
//
// KEY INSIGHT: <select> option values are Dataverse GUIDs — identical on
// both EN and FR pages. Setting el.value = "f23dc860-..." selects the
// correct option regardless of display language ("Canada" or "Canada",
// "United States" or "États-Unis").
//
// LIMITATION: File inputs cannot be programmatically set (browser security).
// The script shows a warning with the previous filename and temporarily
// removes the required attribute until the user re-selects.
//
// ============================================================================
// DEPENDENCIES
// ============================================================================
//
//   - jQuery (bundled with WET-BOEW)
//   - WET-BOEW wb-frmvld plugin (provides $form.valid())
//   - window.SSI_CONFIG (injected by Liquid template)
//   - Google reCAPTCHA v3 (window.grecaptcha)
//
// ============================================================================
// BROWSER SUPPORT
// ============================================================================
//
//   - ES5 syntax (no arrow functions, no const/let in strict mode issues)
//     to support older enterprise browsers
//   - jQuery for DOM manipulation (WET-BOEW dependency already loaded)
//   - Promise (polyfilled by WET-BOEW for IE11 if needed)
//
// ============================================================================

(function (window, document, $) {
  'use strict';

  // ==========================================================================
  // CONFIGURATION CONSTANTS
  // ==========================================================================
  // These values are either hardcoded (step count, GUIDs) or read from
  // the Liquid-injected SSI_CONFIG object on window.

  /** Total number of form steps (fieldsets in the DOM) */
  var TOTAL_STEPS = 5;

  /** Currently displayed step number (1-indexed) */
  var currentStep = 1;

  /** Configuration object injected by Liquid template via <script> block */
  var CFG = window.SSI_CONFIG || {};

  /** True if the current page is French */
  var IS_FR = CFG.isFr || false;

  /** Power Automate HTTP trigger URL for form submission */
  var FLOW_URL = CFG.flowUrl || '';

  /** Post-submission redirect URL (language-appropriate) */
  var CONFIRM_URL = IS_FR
    ? (CFG.confirmUrlFr || '/fr/demande-ssi/confirmation/')
    : (CFG.confirmUrlEn || '/en/ssi-request/confirmation/');

  /**
   * GUID for Canada in the ethi_country table.
   * Used to determine Country → Province vs. State conditional logic.
   * This GUID is environment-specific — verify in target Dataverse instance.
   */
  var GUID_CANADA = 'f23dc860-6f39-ef11-a317-000d3af44283';

  /**
   * GUID for the "Other" option in the ethi_country table.
   * When selected as Flag in Registry, shows the "Other Registry Flag"
   * free-text input field.
   */
  var GUID_OTHER_REGISTRY = 'f8fad702-0328-ef11-840a-000d3af40fa9';

  /** Maximum file size in bytes (4 MB) for ship particulars / existing SSC */
  var FILE_MAX_BYTES = 4 * 1024 * 1024;

  /** Allowed file extensions for uploads */
  var FILE_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif'];

  /**
   * SessionStorage key for language toggle form state persistence.
   * Prefixed with 'ssi-' to avoid conflicts with other portal features.
   */
  var STORAGE_KEY = 'ssi-form-state';


  // ==========================================================================
  // BILINGUAL MESSAGE STRINGS
  // ==========================================================================
  // All user-facing strings determined at initialization based on IS_FR.
  // This keeps bilingual logic out of individual functions.

  var MSG = {
    submitting:     IS_FR ? 'Soumission en cours…'         : 'Submitting…',
    submitLabel:    IS_FR ? 'Soumettre'                     : 'Submit',
    submitError:    IS_FR ? 'Une erreur est survenue. Veuillez réessayer.' : 'An error occurred. Please try again.',
    fileTooLarge:   IS_FR ? 'Le fichier dépasse 4 Mo.'     : 'File exceeds 4 MB.',
    fileWrongType:  IS_FR ? 'Type de fichier non accepté.'  : 'File type not accepted.',
    fileEmpty:      IS_FR ? 'Le fichier est vide.'          : 'File is empty.',
    dateError:      IS_FR ? 'La date d\'arrivée doit être antérieure ou égale à la date de départ.' :
                            'Arrival date must be on or before departure date.',
    fileReselect:   IS_FR ? 'Fichier précédent : '          : 'Previous file: ',
    fileReselect2:  IS_FR ? ' — veuillez le sélectionner à nouveau.' : ' — please re-select it.',
    reviewStep1:    IS_FR ? 'Agence maritime'               : 'Shipping Agency',
    reviewStep2:    IS_FR ? 'Facturation'                   : 'Invoicing',
    reviewStep3:    IS_FR ? 'Navire'                        : 'Vessel',
    reviewStep4:    IS_FR ? 'Service'                       : 'Service'
  };


  // ==========================================================================
  // DOM REFERENCES
  // ==========================================================================
  // Cached jQuery objects for frequently accessed elements.
  // Initialized in initialize() after DOM is ready.

  var $form, form, $btnPrev, $btnNext, $btnSubmit;


  // ==========================================================================
  // LOGGING
  // ==========================================================================
  // Structured console logging with a consistent prefix for easy filtering.
  // In production, these could be conditionally suppressed via a config flag.

  var LOG = '[SSI-v2]';
  var log = {
    info:  function (m, d) { console.log(LOG, m, d || ''); },
    warn:  function (m, d) { console.warn(LOG, m, d || ''); },
    error: function (m, d) { console.error(LOG, m, d || ''); },
    debug: function (m, d) { console.log(LOG, '[DBG]', m, d || ''); }
  };


  // ==========================================================================
  // STEP NAVIGATION
  // ==========================================================================

  /**
   * Show a specific step and update all related UI elements.
   *
   * This function is the central navigation controller. It:
   *   1. Hides all step panels by adding .step-hidden
   *   2. Shows the target step by removing .step-hidden
   *   3. Updates the progress indicator (active/completed classes)
   *   4. Shows/hides Previous/Next/Submit buttons
   *   5. Updates document.title for screen readers
   *   6. Moves focus to the step's <legend> for accessibility
   *   7. Pushes browser history state for Back button support
   *   8. On Step 5: generates review summary and sets timestamp
   *
   * @param {number} step - Step number to show (1-5)
   */
  function showStep(step) {
    // 1. Hide all step panels
    $('.step-panel').addClass('step-hidden');

    // 2. Show target step
    var $target = $('#step-' + step);
    $target.removeClass('step-hidden');

    // 3. Update progress indicator
    //    - Steps before current: "completed" (green checkmark)
    //    - Current step: "active" with aria-current="step"
    //    - Steps after current: default (grey)
    $('#ssi-progress li').each(function (i) {
      var n = i + 1;
      var $li = $(this);
      $li.removeClass('active completed').removeAttr('aria-current');
      if (n === step) $li.addClass('active').attr('aria-current', 'step');
      else if (n < step) $li.addClass('completed');
    });

    // 4. Button visibility
    //    Previous: hidden on Step 1, visible on 2-5
    //    Next: visible on Steps 1-4, hidden on Step 5
    //    Submit: only visible on Step 5
    $btnPrev.toggle(step > 1);
    $btnNext.toggle(step < TOTAL_STEPS);
    $btnSubmit.toggle(step === TOTAL_STEPS);

    // 5. Update page title (announced by screen readers on focus change)
    var title = $target.find('legend').first().text().trim();
    document.title = title;

    // 6. Focus management — move focus to legend for screen reader announcement.
    //    tabindex="-1" makes the legend programmatically focusable without
    //    adding it to the tab order.
    var legend = $target.find('legend')[0];
    if (legend) {
      legend.setAttribute('tabindex', '-1');
      legend.focus();
    }

    // 7. Browser history — enables Back button to return to previous step
    //    instead of leaving the page entirely.
    if (window.history && window.history.pushState) {
      history.pushState({ step: step }, '', '?step=' + step);
    }

    currentStep = step;
    log.info('Step ' + step);

    // 8. Final step: generate review summary and set submission timestamp
    if (step === TOTAL_STEPS) {
      generateReviewSummary();
      setSubmitTimestamp();
    }
  }

  /**
   * Validate the current step before allowing navigation forward.
   *
   * Runs custom validations first (files, dates), then delegates to
   * wb-frmvld via $form.valid(). The ignore selector in wb-frmvld
   * ensures only visible fields are checked.
   *
   * @returns {boolean} True if current step passes all validation
   */
  function validateCurrentStep() {
    // Custom file validation (Step 3 only) — runs before wb-frmvld
    // because wb-frmvld can't check file size/type
    if (!validateFiles()) return false;

    // Custom date comparison (Step 4 only) — arrival ≤ departure
    if (currentStep === 4 && !validateDateComparison()) return false;

    // Delegate to wb-frmvld (jQuery Validate) for all other rules
    // (required, pattern, maxlength, email, postalCodeCA, etc.)
    return $form.valid();
  }


  // ==========================================================================
  // LANGUAGE TOGGLE — FORM STATE PRESERVATION
  // ==========================================================================
  //
  // The WET language toggle (#wb-lng a) navigates to the paired Web Page
  // in the other language (full page reload). Without preservation, all
  // form data is lost.
  //
  // STRATEGY:
  //   1. Intercept the toggle click
  //   2. Serialize all form state to sessionStorage
  //   3. Let the navigation proceed
  //   4. On new page load, restore state from sessionStorage
  //
  // DATA STORED:
  //   - fields: { id → value } for text/email/tel/date/number/select/textarea
  //   - radio: { name → value } for checked radio buttons
  //   - files: { id → filename } for file inputs (can't persist actual files)
  //   - step: current step number
  //
  // RESTORATION ORDER MATTERS:
  //   1. Radio buttons first — CCG toggle drives #invoice-section visibility
  //   2. 300ms delay — let CSS transitions/slideDown complete
  //   3. Text/select values — country selects trigger province/state toggle
  //   4. File warnings — inform user about re-selection requirement
  //   5. Navigate to saved step
  // ==========================================================================

  /**
   * Attach click handler to the WET language toggle link.
   * Serializes form state to sessionStorage before navigation.
   */
  function initLanguageToggle() {
    $('#wb-lng a').on('click', function (e) {
      e.preventDefault();
      var targetUrl = $(this).attr('href');

      // Build state object
      var state = {
        step: currentStep,
        fields: {},
        radio: {},
        files: {}
      };

      // Capture text/select/textarea values by element ID.
      // Excludes file inputs (can't restore), radio buttons (separate),
      // and hidden inputs (system fields like CSRF token).
      $('#ssi-request').find(
        'input:not([type="file"]):not([type="radio"]):not([type="hidden"]), select, textarea'
      ).each(function () {
        if (this.id && this.value) {
          state.fields[this.id] = this.value;
        }
      });

      // Capture checked radio buttons by name attribute.
      // Only one radio per name can be checked, so name→value is 1:1.
      $('#ssi-request input[type="radio"]:checked').each(function () {
        state.radio[this.name] = this.value;
      });

      // Capture file input filenames (not the actual file data).
      // Used to show "Previous file: X — please re-select" warnings.
      $('#ssi-request input[type="file"]').each(function () {
        if (this.files && this.files[0]) {
          state.files[this.id] = this.files[0].name;
        }
      });

      // Persist to sessionStorage (survives page navigation, cleared on tab close)
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        log.info('Form state saved for language toggle', {
          step: state.step,
          fieldCount: Object.keys(state.fields).length
        });
      } catch (err) {
        // sessionStorage may be unavailable in private browsing or quota exceeded
        log.warn('Failed to save form state', err);
      }

      // Proceed with navigation to other-language page
      window.location.href = targetUrl;
    });
  }

  /**
   * On page load, check for saved form state from a language toggle.
   * If found, restore all field values, trigger conditional logic,
   * and navigate to the saved step.
   *
   * Called once during initialize(), after showStep(1) has run.
   * The saved state is consumed immediately (removed from sessionStorage)
   * to prevent stale data on refresh.
   */
  function restoreFormState() {
    var saved;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return; // sessionStorage not available (private browsing, etc.)
    }

    if (!saved) return;

    // Remove immediately — one-time use. If page errors during restore,
    // we don't want stale state on next load.
    sessionStorage.removeItem(STORAGE_KEY);

    try {
      var state = JSON.parse(saved);
      log.info('Restoring form state', {
        step: state.step,
        fieldCount: Object.keys(state.fields).length
      });

      // STEP 1: Restore radio buttons FIRST.
      // The CCG radio drives #invoice-section visibility. If we restore
      // text fields first, invoice fields might be inside a hidden section
      // and their values could be cleared by conditional logic.
      Object.keys(state.radio).forEach(function (name) {
        var radio = document.querySelector(
          'input[name="' + name + '"][value="' + state.radio[name] + '"]'
        );
        if (radio) {
          radio.checked = true;
          // Trigger change to activate conditional logic (CCG toggle)
          $(radio).trigger('change');
        }
      });

      // STEP 2: Wait for CSS transitions.
      // The CCG toggle uses slideDown(200ms). We wait 300ms to ensure
      // the invoice section is fully visible before trying to set values
      // on elements inside it.
      setTimeout(function () {

        // STEP 3: Restore text/select/textarea values.
        Object.keys(state.fields).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) {
            // Set the value. For <select> elements, this works because
            // option values are Dataverse GUIDs — identical across languages.
            el.value = state.fields[id];

            // Trigger change for <select> elements to activate cascading
            // conditional logic (country → province/state, flag → other).
            if (el.tagName === 'SELECT') {
              $(el).trigger('change');
            }
          }
        });

        // STEP 4: Handle file inputs — show warning with previous filename.
        // Browser security prevents programmatically setting file input values.
        // We inform the user and temporarily remove required to allow navigation.
        Object.keys(state.files).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) {
            var $group = $(el).closest('.form-group');
            // Remove any existing warnings (idempotent)
            $group.find('.file-reselect-warning').remove();
            // Add warning message
            $group.append(
              '<p class="text-warning file-reselect-warning">' +
              '<span class="glyphicon glyphicon-exclamation-sign" aria-hidden="true"></span> ' +
              MSG.fileReselect +
              '<strong>' + escapeHtml(state.files[id]) + '</strong>' +
              MSG.fileReselect2 +
              '</p>'
            );
            // Temporarily remove required. The initFileRequiredRestore()
            // handler will re-add it when the user selects a new file.
            if (el.hasAttribute('required')) {
              el.removeAttribute('required');
              el.setAttribute('data-file-was-required', 'true');
            }
          }
        });

        // STEP 5: Navigate to the saved step.
        if (state.step && state.step > 1) {
          showStep(state.step);
        }

        log.info('Form state restored');
      }, 300);

    } catch (err) {
      log.error('Failed to restore form state', err);
    }
  }

  /**
   * Re-apply the required attribute to file inputs when the user selects
   * a new file after a language toggle restore.
   *
   * During restore, required is temporarily removed from file inputs
   * (because we can't programmatically set their value). This handler
   * restores the required attribute and removes the warning message
   * when the user manually selects a file.
   */
  function initFileRequiredRestore() {
    $('#ssi-request input[type="file"]').on('change', function () {
      // Check if this input had required temporarily removed
      if (this.getAttribute('data-file-was-required') === 'true') {
        this.setAttribute('required', 'required');
        this.removeAttribute('data-file-was-required');
      }
      // Remove the "previous file" warning message
      $(this).closest('.form-group').find('.file-reselect-warning').remove();
    });
  }


  // ==========================================================================
  // CONDITIONAL FIELD LOGIC
  // ==========================================================================
  //
  // Three conditional toggles manage field visibility and required states:
  //
  // 1. CCG Toggle (Step 2):
  //    CCG = Yes → Hide entire #invoice-section, strip required from all fields
  //    CCG = No  → Show #invoice-section, restore required attributes
  //
  // 2. Country Toggle (Step 2, inside invoice section):
  //    Canada    → Province dropdown + Postal Code (CA validation)
  //    Not Canada → State text + ZIP Code
  //
  // 3. Registry Flag Toggle (Step 3):
  //    "Other" GUID → Show Other Registry Flag text input
  //    Any other    → Hide it
  //
  // All toggles use jQuery slideDown/slideUp for smooth transitions and
  // properly manage required attributes to prevent wb-frmvld from
  // validating fields that are not visible.
  // ==========================================================================

  /**
   * Canadian Coast Guard toggle — controls #invoice-section visibility.
   *
   * When CCG = Yes (Coast Guard vessel), no invoice is needed, so the
   * entire invoice section is hidden and all required attributes within
   * it are removed. The data-was-required attribute preserves the original
   * required state for restoration when CCG = No.
   */
  function initCCGToggle() {
    $('input[name="ethi_canadiancoastguard"]').on('change', function () {
      var isYes = $(this).val() === 'true';
      var $section = $('#invoice-section');

      if (isYes) {
        // Hide invoice section, remove required from all fields within
        $section.slideUp(200);
        $section.find('[required]').each(function () {
          $(this).removeAttr('required').attr('data-was-required', 'true');
        });
      } else {
        // Show invoice section, restore required on fields that had it
        $section.slideDown(200);
        $section.find('[data-was-required]').each(function () {
          $(this).attr('required', 'required').removeAttr('data-was-required');
        });
      }
    });
  }

  /**
   * Invoice Country toggle — switches Province/State and Postal/ZIP fields.
   *
   * When Canada is selected:
   *   - Show Province dropdown (pre-populated by fetchxml)
   *   - Show Postal Code input (with postalCodeCA validation)
   *   - Hide State text input
   *   - Hide ZIP Code input
   *
   * When any other country is selected, the reverse.
   */
  function initCountryToggle() {
    $('#ethi_invoicecountry').on('change', function () {
      var isCanada = ($(this).val() === GUID_CANADA);

      // toggleConditionalField(groupSelector, fieldSelector, shouldShow)
      toggleConditionalField('#invoice-province-group', '#ethi_invoiceprovince', isCanada);
      toggleConditionalField('#invoice-state-group', '#ethi_invoiceprovincestate', !isCanada);
      toggleConditionalField('#invoice-postalcode-group', '#ethi_invoicepostalcode', isCanada);
      toggleConditionalField('#invoice-zipcode-group', '#ethi_invoicepostalcodezipcode', !isCanada);
    });
  }

  /**
   * Flag in Registry toggle — shows "Other" text input when the
   * "Other" country option is selected.
   */
  function initRegistryFlagToggle() {
    $('#ethi_flaginregistry').on('change', function () {
      toggleConditionalField(
        '#other-registry-group',
        '#ethi_otherregistryflag',
        $(this).val() === GUID_OTHER_REGISTRY
      );
    });
  }

  /**
   * Generic helper to show/hide a form group and manage its field's
   * required attribute.
   *
   * When hiding: removes required and clears the field value.
   * When showing: restores required if the label has class="required".
   *
   * @param {string} groupSel  - jQuery selector for the .form-group wrapper
   * @param {string} fieldSel  - jQuery selector for the input/select inside
   * @param {boolean} show     - True to show, false to hide
   */
  function toggleConditionalField(groupSel, fieldSel, show) {
    var $group = $(groupSel);
    var $field = $(fieldSel);
    if (show) {
      $group.show();
      // Restore required if the label indicates it should be required
      if ($field.attr('data-was-required') === 'true' ||
          $field.closest('.form-group').find('label').hasClass('required')) {
        $field.attr('required', 'required');
      }
    } else {
      $group.hide();
      // Remove required and clear value — prevents validation of hidden fields
      $field.removeAttr('required').val('');
    }
  }


  // ==========================================================================
  // CUSTOM VALIDATION
  // ==========================================================================
  //
  // These validations supplement wb-frmvld for cases it can't handle:
  //   - File size and type checking (wb-frmvld doesn't inspect file content)
  //   - Cross-field date comparison (wb-frmvld doesn't support field comparison)
  //
  // Both functions are called by validateCurrentStep() BEFORE $form.valid()
  // so that custom errors are shown alongside wb-frmvld errors.
  // ==========================================================================

  /**
   * Validate file inputs on Step 3 (Ship Particulars and Existing SSC).
   *
   * Checks:
   *   - File is not empty (0 bytes)
   *   - File does not exceed 4 MB
   *   - File extension is in the allowed list
   *
   * Note: wb-frmvld handles the "required" check for Ship Particulars.
   * This function only validates file CONTENT for files that are present.
   *
   * @returns {boolean} True if all files pass validation
   */
  function validateFiles() {
    if (currentStep !== 3) return true;
    var valid = true;
    var inputs = [
      { id: 'ethi_uploadshipparticulars', req: true },
      { id: 'ethi_existingssc', req: false }
    ];

    inputs.forEach(function (cfg) {
      var el = document.getElementById(cfg.id);
      if (!el) return;
      var file = el.files && el.files[0];
      var $g = $(el).closest('.form-group');

      // Clear previous custom errors
      $g.find('.file-error').remove();
      $g.removeClass('has-error');

      // If required and no file, let wb-frmvld handle it
      if (cfg.req && !file) return;

      // Validate file properties if present
      if (file) {
        var ext = file.name.split('.').pop().toLowerCase();
        if (file.size === 0) {
          showFieldError($g, el, MSG.fileEmpty);
          valid = false;
        } else if (file.size > FILE_MAX_BYTES) {
          showFieldError($g, el, MSG.fileTooLarge);
          valid = false;
        } else if (FILE_ALLOWED_EXT.indexOf(ext) === -1) {
          showFieldError($g, el, MSG.fileWrongType);
          valid = false;
        }
      }
    });
    return valid;
  }

  /**
   * Validate that arrival date ≤ departure date (Step 4).
   *
   * Only validates when both dates are provided (both are optional fields).
   * Shows an error on the arrival date field if the comparison fails.
   *
   * @returns {boolean} True if dates are valid or not both provided
   */
  function validateDateComparison() {
    var a = document.getElementById('ethi_vesselexpectedarrivaldate').value;
    var d = document.getElementById('ethi_vesselexpecteddeparturedate').value;

    // Skip if either date is empty (both are optional)
    if (!a || !d) return true;

    if (new Date(a) > new Date(d)) {
      var $g = $('#ethi_vesselexpectedarrivaldate').closest('.form-group');
      showFieldError($g, document.getElementById('ethi_vesselexpectedarrivaldate'), MSG.dateError);
      return false;
    }
    return true;
  }

  /**
   * Display a custom error message on a form field.
   *
   * Creates an error element with proper ARIA linkage:
   *   - aria-describedby on the input points to the error
   *   - aria-invalid="true" marks the field as invalid
   *   - has-error class triggers Bootstrap error styling
   *
   * @param {jQuery}      $g  - The .form-group wrapper
   * @param {HTMLElement} el  - The input element
   * @param {string}      msg - Error message text
   */
  function showFieldError($g, el, msg) {
    $g.addClass('has-error');
    var eid = el.id + '-file-error';
    $g.append(
      '<strong id="' + eid + '" class="file-error error">' +
      '<span class="label label-danger">' + msg + '</span>' +
      '</strong>'
    );
    el.setAttribute('aria-describedby', eid);
    el.setAttribute('aria-invalid', 'true');
  }

  /**
   * Strip non-digit characters from phone inputs on every keystroke.
   *
   * Attached to all type="tel" inputs. This ensures the 10-digit pattern
   * validation works correctly by preventing users from entering spaces,
   * dashes, parentheses, etc. The pattern="[0-9]{10}" attribute then
   * validates the clean digit-only string.
   */
  function initPhoneStripping() {
    $('input[type="tel"]').on('input', function () {
      this.value = this.value.replace(/\D/g, '');
    });
  }


  // ==========================================================================
  // REVIEW SUMMARY (Step 5)
  // ==========================================================================
  //
  // Generates a read-only HTML summary of all form data for user verification
  // before submission. The summary is organized into 4 sections (Steps 1-4)
  // with HTML tables showing label/value pairs.
  //
  // Helper functions:
  //   rf()  — Review Field: reads text/email/tel input value
  //   rlf() — Review Lookup Field: reads select's visible text (not GUID)
  //   rff() — Review File Field: reads filename from file input
  // ==========================================================================

  /**
   * Build the review summary HTML and inject it into #review-content.
   * Called automatically when the user navigates to Step 5.
   */
  function generateReviewSummary() {
    var html = '';

    // Step 1: Shipping Agency
    html += reviewSection(MSG.reviewStep1, [
      rf('ethi_nameofshippingagentcompany'),
      rf('ethi_firstnameofshippingagentrequestingservices'),
      rf('ethi_lastnameofshippingagentrequestingservices'),
      rf('ethi_organizationphone'),
      rf('ethi_organizationphoneextension'),
      rf('ethi_secondaryphone'),
      rf('ethi_organizationemail')
    ]);

    // Step 2: Invoice (conditional on CCG)
    var ccg = $('input[name="ethi_canadiancoastguard"]:checked').val();
    var ccgLabel = ccg === 'true' ? (IS_FR ? 'Oui' : 'Yes') : (IS_FR ? 'Non' : 'No');
    var s2 = [{ label: IS_FR ? 'Garde côtière canadienne' : 'Canadian Coast Guard', value: ccgLabel }];
    if (ccg === 'false') {
      s2.push(
        rf('ethi_invoicingname'), rlf('ethi_invoicecountry'), rlf('ethi_invoiceprovince'),
        rf('ethi_invoiceprovincestate'), rf('ethi_invoicecity'), rf('ethi_invoiceaddressline1'),
        rf('ethi_invoiceaddressline2'), rf('ethi_invoicepostalcode'), rf('ethi_invoicepostalcodezipcode'),
        rf('ethi_businessnumber'), rf('ethi_isorganizationnumber'), rf('ethi_isreferencenumber')
      );
    }
    html += reviewSection(MSG.reviewStep2, s2);

    // Step 3: Vessel
    html += reviewSection(MSG.reviewStep3, [
      rf('ethi_shipname'), rf('ethi_vesselname'), rf('ethi_imoregistrationnumber'),
      rf('ethi_callsign'), rf('ethi_portofregistry'), rf('ethi_nettonnage'),
      rf('ethi_numberofholds'), rf('ethi_typeofcargo'), rf('ethi_shipowner'),
      rlf('ethi_flaginregistry'), rf('ethi_otherregistryflag'),
      rff('ethi_uploadshipparticulars'), rff('ethi_existingssc')
    ]);

    // Step 4: Service
    html += reviewSection(MSG.reviewStep4, [
      rlf('ethi_serviceprovince'), rf('ethi_servicecityname'), rf('ethi_servicelocation'),
      rf('ethi_dock'), rf('ethi_vesselexpectedarrivaldate'), rf('ethi_vesselexpecteddeparturedate'),
      rf('ethi_previousportofcall'), rf('ethi_nextportofcall'),
      rf('ethi_certificatesexpiresdate'), rf('ethi_additionalcomments')
    ]);

    $('#review-content').html(html);
  }

  /**
   * Build an HTML section (heading + table) for the review summary.
   * Only renders fields that have a non-empty value.
   *
   * @param {string} title  - Section heading text
   * @param {Array}  fields - Array of {label, value} objects (or nulls)
   * @returns {string} HTML string, or empty string if no fields have values
   */
  function reviewSection(title, fields) {
    var rows = '';
    fields.forEach(function (f) {
      if (f && f.value) {
        rows += '<tr><th scope="row">' + f.label + '</th><td>' + escapeHtml(f.value) + '</td></tr>';
      }
    });
    if (!rows) return '';
    return '<h3>' + title + '</h3><table class="table table-striped table-condensed"><tbody>' + rows + '</tbody></table>';
  }

  /**
   * Review Field — read a text/email/tel/date/number input's value.
   * @param {string} id - Element ID
   * @returns {Object|null} {label, value} or null if empty
   */
  function rf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.value } : null;
  }

  /**
   * Review Lookup Field — read a <select>'s visible option text (not the GUID).
   * This shows the user-friendly name ("Ontario") rather than the GUID.
   * @param {string} id - Element ID
   * @returns {Object|null} {label, value} or null if empty
   */
  function rlf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.options[el.selectedIndex].text } : null;
  }

  /**
   * Review File Field — read a file input's filename.
   * @param {string} id - Element ID
   * @returns {Object|null} {label, value} or null if no file selected
   */
  function rff(id) {
    var el = document.getElementById(id);
    return (el && el.files && el.files[0]) ? { label: getLabelText(id), value: el.files[0].name } : null;
  }

  /**
   * Get the visible label text for a form field.
   * Looks for <label for="id"> and extracts the .field-name span text.
   * Falls back to the full label text, then to the element ID.
   *
   * @param {string} id - Element ID
   * @returns {string} Label text
   */
  function getLabelText(id) {
    var $lbl = $('label[for="' + id + '"]');
    if ($lbl.length) {
      // Prefer .field-name span to exclude "(required)" text
      var $fn = $lbl.find('.field-name');
      return $fn.length ? $fn.text().trim() : $lbl.text().trim();
    }
    // For radio groups, look at the parent fieldset's legend
    var $legend = $('#' + id).closest('fieldset').find('legend .field-name');
    return $legend.length ? $legend.text().trim() : id;
  }

  /**
   * Escape HTML special characters to prevent XSS in review summary.
   * Uses the browser's text node escaping via createElement/textContent.
   *
   * @param {string} s - Raw string
   * @returns {string} HTML-safe string
   */
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }


  // ==========================================================================
  // SUBMIT TIMESTAMP
  // ==========================================================================

  /**
   * Generate a UTC timestamp and set it on the hidden ethi_submittimeutc field.
   * Format: "YYYY-MM-DD HH:MM AM/PM UTC"
   *
   * Called when Step 5 becomes active so the timestamp reflects when
   * the user reached the review step, not when they started filling the form.
   */
  function setSubmitTimestamp() {
    var n = new Date();
    var h = n.getUTCHours();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    var ts = n.getUTCFullYear() + '-' +
      String(n.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(n.getUTCDate()).padStart(2, '0') + ' ' +
      String(h).padStart(2, '0') + ':' +
      String(n.getUTCMinutes()).padStart(2, '0') + ' ' + ap + ' UTC';
    document.getElementById('ethi_submittimeutc').value = ts;
  }


  // ==========================================================================
  // RECAPTCHA
  // ==========================================================================

  /**
   * Execute Google reCAPTCHA v3 and return the token.
   *
   * reCAPTCHA v3 is invisible — no user interaction required. It scores
   * the user's behavior (0.0 = bot, 1.0 = human). The token is sent to
   * the Power Automate flow, which verifies it server-side with Google's
   * siteverify API.
   *
   * @returns {Promise<string|null>} reCAPTCHA token or null if unavailable
   */
  function executeRecaptcha() {
    return new Promise(function (resolve) {
      if (!window.grecaptcha) {
        log.warn('reCAPTCHA not loaded');
        resolve(null);
        return;
      }
      grecaptcha.ready(function () {
        grecaptcha.execute('YOUR_SITE_KEY', { action: 'ssi_submit' })
          .then(resolve)
          .catch(function () { resolve(null); });
      });
    });
  }


  // ==========================================================================
  // SUBMISSION — Power Automate Flow
  // ==========================================================================

  /**
   * Build the JSON payload for the Power Automate flow.
   *
   * The flow expects a flat JSON object with field values. Lookup fields
   * are sent as _guid suffixed properties (e.g., ethi_invoicecountry_guid).
   * The flow is responsible for converting these to OData @odata.bind
   * syntax when creating the Dataverse record.
   *
   * Conditional fields are only included when their parent section is
   * visible (CCG = No for invoice, country-specific for province/state).
   * Null/empty values are stripped from the payload to reduce size.
   *
   * @returns {Object} JSON payload for the flow
   */
  function buildPayload() {
    var ccg = $('input[name="ethi_canadiancoastguard"]:checked').val();
    var countryGuid = val('ethi_invoicecountry');
    var flagGuid = val('ethi_flaginregistry');
    var serviceProv = val('ethi_serviceprovince');

    var payload = {
      // --- Step 1: Shipping Agency ---
      ethi_nameofshippingagentcompany: val('ethi_nameofshippingagentcompany'),
      ethi_firstnameofshippingagentrequestingservices: val('ethi_firstnameofshippingagentrequestingservices'),
      ethi_lastnameofshippingagentrequestingservices: val('ethi_lastnameofshippingagentrequestingservices'),
      ethi_organizationphone: val('ethi_organizationphone'),
      ethi_organizationphoneextension: val('ethi_organizationphoneextension'),
      ethi_secondaryphone: val('ethi_secondaryphone'),
      ethi_organizationemail: val('ethi_organizationemail'),

      // --- Step 2: Invoice ---
      ethi_canadiancoastguard: (ccg === 'true'),
      // Invoice fields only when CCG = No (not Coast Guard vessel)
      ethi_invoicingname: ccg === 'false' ? val('ethi_invoicingname') : null,
      ethi_invoiceaddressline1: ccg === 'false' ? val('ethi_invoiceaddressline1') : null,
      ethi_invoiceaddressline2: ccg === 'false' ? val('ethi_invoiceaddressline2') : null,
      ethi_invoicecity: ccg === 'false' ? val('ethi_invoicecity') : null,
      ethi_invoicecountry_guid: ccg === 'false' ? countryGuid : null,
      // Province (dropdown) when Canada, State (text) when non-Canada
      ethi_invoiceprovince_guid: (ccg === 'false' && countryGuid === GUID_CANADA) ? val('ethi_invoiceprovince') : null,
      ethi_invoiceprovincestate: (ccg === 'false' && countryGuid !== GUID_CANADA) ? val('ethi_invoiceprovincestate') : null,
      ethi_invoicepostalcode: (ccg === 'false' && countryGuid === GUID_CANADA) ? val('ethi_invoicepostalcode') : null,
      ethi_invoicepostalcodezipcode: (ccg === 'false' && countryGuid !== GUID_CANADA) ? val('ethi_invoicepostalcodezipcode') : null,
      ethi_businessnumber: ccg === 'false' ? val('ethi_businessnumber') : null,
      ethi_isorganizationnumber: ccg === 'false' ? val('ethi_isorganizationnumber') : null,
      ethi_isreferencenumber: ccg === 'false' ? val('ethi_isreferencenumber') : null,

      // --- Step 3: Vessel ---
      ethi_shipname: val('ethi_shipname'),
      ethi_vesselname: val('ethi_vesselname'),
      ethi_imoregistrationnumber: val('ethi_imoregistrationnumber'),
      ethi_callsign: val('ethi_callsign'),
      ethi_portofregistry: val('ethi_portofregistry'),
      ethi_nettonnage: parseInt(val('ethi_nettonnage'), 10) || null,
      ethi_numberofholds: parseInt(val('ethi_numberofholds'), 10) || null,
      ethi_typeofcargo: val('ethi_typeofcargo'),
      ethi_shipowner: val('ethi_shipowner'),
      ethi_flaginregistry_guid: flagGuid || null,
      ethi_otherregistryflag: (flagGuid === GUID_OTHER_REGISTRY) ? val('ethi_otherregistryflag') : null,

      // --- Step 4: Service ---
      ethi_serviceprovince_guid: serviceProv || null,
      ethi_servicecityname: val('ethi_servicecityname'),
      ethi_servicelocation: val('ethi_servicelocation'),
      ethi_dock: val('ethi_dock'),
      ethi_vesselexpectedarrivaldate: val('ethi_vesselexpectedarrivaldate') || null,
      ethi_vesselexpecteddeparturedate: val('ethi_vesselexpecteddeparturedate') || null,
      ethi_previousportofcall: val('ethi_previousportofcall'),
      ethi_nextportofcall: val('ethi_nextportofcall'),
      ethi_certificatesexpiresdate: val('ethi_certificatesexpiresdate') || null,
      ethi_additionalcomments: val('ethi_additionalcomments'),

      // --- System ---
      ethi_submittimeutc: val('ethi_submittimeutc')
    };

    // Strip nulls and empty strings to reduce payload size
    Object.keys(payload).forEach(function (k) {
      if (payload[k] === null || payload[k] === '' || payload[k] === undefined) {
        delete payload[k];
      }
    });

    return payload;
  }

  /**
   * Shorthand to get a trimmed value from a form field by ID.
   * @param {string} id - Element ID
   * @returns {string} Trimmed value, or empty string if element not found
   */
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  /**
   * Upload a file to a Dataverse file column via Power Pages Web API.
   *
   * Uses PUT with application/octet-stream content type. The file column
   * name in the URL path determines which column receives the file.
   *
   * This requires a table permission granting anonymous Update on
   * ethi_ssirequestportal, scoped to the specific file columns only.
   *
   * @param {string} recordId  - GUID of the created Dataverse record
   * @param {string} columnName - Dataverse file column logical name
   * @param {string} inputId   - DOM ID of the <input type="file">
   * @returns {Promise} Resolves when upload completes (or skips if no file)
   */
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
            // CSRF token required by Power Pages Web API
            '__RequestVerificationToken': $('input[name="__RequestVerificationToken"]').val(),
            // Filename header tells Dataverse what to name the stored file
            'x-ms-file-name': encodeURIComponent(file.name)
          },
          data: reader.result
        }).then(resolve).fail(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Full form submission sequence.
   *
   * 1. Disable submit button to prevent double-submission
   * 2. Get reCAPTCHA v3 token from Google
   * 3. Build JSON payload from all form fields
   * 4. POST to Power Automate flow (validates + creates record)
   * 5. Upload files to Dataverse file columns (parallel)
   * 6. Clear sessionStorage and redirect to confirmation page
   *
   * On error: re-enable submit button, show alert, auto-dismiss after 10s.
   */
  function handleSubmit() {
    $btnSubmit.prop('disabled', true).text(MSG.submitting);
    log.info('=== Submit ===');

    executeRecaptcha()
      .then(function (token) {
        var payload = buildPayload();
        payload.recaptchaToken = token || '';
        log.debug('Payload', payload);

        // POST to Power Automate flow
        return $.ajax({
          url: FLOW_URL,
          type: 'POST',
          contentType: 'application/json',
          data: JSON.stringify(payload)
        });
      })
      .then(function (response) {
        // Flow returns { id: "guid-of-created-record" }
        var recordId = response.id;
        log.info('Record: ' + recordId);

        // Upload files in parallel — both resolve even if no file selected
        return Promise.all([
          uploadFile(recordId, 'ethi_uploadshipparticulars', 'ethi_uploadshipparticulars'),
          uploadFile(recordId, 'ethi_existingssc', 'ethi_existingssc')
        ]);
      })
      .then(function () {
        log.info('=== Complete ===');

        // Clean up any leftover sessionStorage from language toggles
        try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }

        // Redirect to confirmation page (language-appropriate URL)
        window.location.href = CONFIRM_URL;
      })
      .catch(function (err) {
        log.error('Submit failed', err);

        // Re-enable submit button
        $btnSubmit.prop('disabled', false).text(MSG.submitLabel);

        // Show error alert above the review summary
        var $alert = $('<div class="alert alert-danger" role="alert"><p>' + MSG.submitError + '</p></div>');
        $('#review-summary').before($alert);
        // Make focusable and focus for screen reader announcement
        $alert[0].setAttribute('tabindex', '-1');
        $alert[0].focus();
        // Auto-dismiss after 10 seconds
        setTimeout(function () { $alert.fadeOut(function () { $alert.remove(); }); }, 10000);
      });
  }


  // ==========================================================================
  // BROWSER HISTORY
  // ==========================================================================

  /**
   * Handle browser Back/Forward button navigation between steps.
   *
   * When showStep() runs, it pushes state with history.pushState().
   * When the user clicks Back, the popstate event fires and we navigate
   * to the step stored in the history state.
   *
   * This prevents the Back button from leaving the form entirely —
   * instead it returns to the previous step.
   */
  function initHistoryHandler() {
    window.addEventListener('popstate', function (e) {
      if (e.state && e.state.step) {
        currentStep = e.state.step;
        showStep(currentStep);
      }
    });
  }


  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Main initialization function. Called when WET-BOEW is ready.
   *
   * ORDER OF OPERATIONS:
   *   1. Cache DOM references
   *   2. Attach navigation button handlers
   *   3. Attach form submit handler (prevents default, runs handleSubmit)
   *   4. Initialize conditional logic (CCG, Country, Registry Flag)
   *   5. Initialize input behaviors (phone stripping, file required restore)
   *   6. Initialize language toggle preservation
   *   7. Initialize browser history handler
   *   8. Show initial step (from URL ?step= parameter or default to 1)
   *   9. Restore form state if navigating from language toggle
   *
   * The WET ready event (wb-ready.wb) ensures wb-frmvld has initialized
   * before we try to use $form.valid(). The fallback setTimeout handles
   * edge cases where the event already fired before our listener attached.
   */
  function initialize() {
    log.info('=== Init v2 ===');

    // 1. Cache DOM references
    form = document.getElementById('ssi-request');
    $form = $(form);
    $btnPrev = $('#btn-prev');
    $btnNext = $('#btn-next');
    $btnSubmit = $('#btn-submit');

    // 2-3. Navigation and submit handlers
    $btnNext.on('click', function () {
      if (validateCurrentStep()) showStep(currentStep + 1);
    });
    $btnPrev.on('click', function () {
      showStep(currentStep - 1);
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (validateCurrentStep()) handleSubmit();
    });

    // 4. Conditional field logic
    initCCGToggle();
    initCountryToggle();
    initRegistryFlagToggle();

    // 5. Input behaviors
    initPhoneStripping();
    initFileRequiredRestore();

    // 6. Language toggle preservation
    initLanguageToggle();

    // 7. Browser history
    initHistoryHandler();

    // 8. Show initial step
    //    Check URL for ?step=N parameter (from browser history or direct link)
    var urlStep = new URLSearchParams(window.location.search).get('step');
    var startStep = (urlStep && parseInt(urlStep, 10) >= 1 && parseInt(urlStep, 10) <= TOTAL_STEPS)
                    ? parseInt(urlStep, 10) : 1;
    showStep(startStep);

    // 9. Restore form state from language toggle (runs after showStep)
    //    This must be LAST because it may call showStep() again to
    //    navigate to the saved step.
    restoreFormState();

    log.info('=== Ready ===');
  }

  // Wait for WET-BOEW to be fully initialized (ensures wb-frmvld is ready)
  $(document).on('wb-ready.wb', function () { initialize(); });

  // Fallback: if document already loaded (event may have fired before listener)
  if (document.readyState === 'complete') setTimeout(initialize, 100);

})(window, document, jQuery);
