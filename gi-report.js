// ============================================================================
// GI REPORT — SINGLE PAGE FORM CONTROLLER (v2)
// ============================================================================
//
// FILE:         gi-report.js
// TYPE:         Client-side form controller
// LAST UPDATED: 2026-02-26
//
// ============================================================================
// PURPOSE
// ============================================================================
//
// Manages the GI (Gastrointestinal Illness) Report single-page form:
// step navigation, conditional field logic, validation, language toggle
// state preservation, review summary generation, and submission to a
// Power Automate flow.
//
// ============================================================================
// ARCHITECTURE
// ============================================================================
//
// The form exists as 5 <fieldset> elements in the DOM. Only one is visible
// at a time (controlled by .step-hidden CSS class). This approach:
//
//   1. Eliminates Power Pages' native multistep engine interference
//   2. Keeps all form data in the DOM (no session state management)
//   3. Enables instant step transitions (no network round-trips)
//   4. Allows wb-frmvld to validate only the visible step via its
//      "ignore" selector that excludes .step-hidden elements
//
// ============================================================================
// STEPS
// ============================================================================
//
//   Step 1: Vessel Details (8 fields)
//   Step 2: Port & Voyage Information (7 fields + 1 conditional)
//   Step 3: GI Case Details (5 fields)
//   Step 4: Contact Information (4 + 4 conditional fields)
//   Step 5: Review & Submit
//
// ============================================================================
// SUBMISSION FLOW (no file uploads — simpler than SSI)
// ============================================================================
//
//   1. User clicks Submit on Step 5
//   2. executeRecaptcha() → Google returns reCAPTCHA v3 token
//   3. buildPayload() → JSON object with all field values
//   4. POST payload + token to Power Automate flow URL
//   5. Flow validates reCAPTCHA, validates payload, creates record
//   6. Flow returns { id: "guid", name: "GI-XXXXXXXXXX" }
//   7. Redirect to confirmation page
//
// ============================================================================
// LANGUAGE TOGGLE PRESERVATION
// ============================================================================
//
// When a user clicks the WET language toggle (#wb-lng a), Power Pages
// navigates to the paired Web Page (full page reload). This script
// intercepts the click, serializes form state to sessionStorage, and
// restores it on the target page.
//
// KEY INSIGHT: <select> option values are Dataverse GUIDs — identical on
// both EN and FR pages. Setting el.value = "03fb7ebd-..." selects the
// correct option regardless of display language.
//
// ============================================================================
// DEPENDENCIES
// ============================================================================
//
//   - jQuery (bundled with WET-BOEW)
//   - WET-BOEW wb-frmvld plugin (provides $form.valid())
//   - window.GI_CONFIG (injected by Liquid template)
//   - Google reCAPTCHA v3 (window.grecaptcha)
//
// ============================================================================
// BROWSER SUPPORT
// ============================================================================
//
//   - ES5 syntax for older enterprise browsers
//   - jQuery for DOM manipulation (WET-BOEW dependency)
//   - Promise (polyfilled by WET-BOEW for IE11)
//
// ============================================================================

(function (window, document, $) {
  'use strict';

  // ==========================================================================
  // CONFIGURATION CONSTANTS
  // ==========================================================================

  /** Total number of form steps */
  var TOTAL_STEPS = 5;

  /** Currently displayed step number (1-indexed) */
  var currentStep = 1;

  /** Configuration object injected by Liquid template */
  var CFG = window.GI_CONFIG || {};

  /** True if the current page is French */
  var IS_FR = CFG.isFr || false;

  /** Power Automate HTTP trigger URL */
  var FLOW_URL = CFG.flowUrl || '';

  /** Post-submission redirect URL (language-appropriate) */
  var CONFIRM_URL = IS_FR
    ? (CFG.confirmUrlFr || '/fr/rapport-ig/confirmation/')
    : (CFG.confirmUrlEn || '/en/gi-report/confirmation/');

  /**
   * GUID for the "Other" port in ethi_servicelocation.
   * When selected as Next Canadian Port, shows the "Other" text input.
   */
  var GUID_OTHER_PORT = '03fb7ebd-13e3-ef11-9342-6045bdf97903';

  /**
   * SessionStorage key for language toggle form state persistence.
   */
  var STORAGE_KEY = 'gi-form-state';


  // ==========================================================================
  // BILINGUAL MESSAGE STRINGS
  // ==========================================================================

  var MSG = {
    submitting:    IS_FR ? 'Soumission en cours…'         : 'Submitting…',
    submitLabel:   IS_FR ? 'Soumettre'                     : 'Submit',
    submitError:   IS_FR ? 'Une erreur est survenue. Veuillez réessayer.' : 'An error occurred. Please try again.',
    dateError:     IS_FR ? 'La date d\'embarquement doit être antérieure ou égale à la date de débarquement.'
                         : 'Embarkation date must be on or before disembarkation date.',
    paxCaseError:  IS_FR ? 'Les cas de MIG des passagers ne peuvent pas dépasser le nombre total de passagers.'
                         : 'Passenger GI cases cannot exceed total passengers.',
    crewCaseError: IS_FR ? 'Les cas de MIG de l\'équipage ne peuvent pas dépasser le nombre total de membres d\'équipage.'
                         : 'Crew GI cases cannot exceed total crew.',
    reviewStep1:   IS_FR ? 'Détails du navire'             : 'Vessel Details',
    reviewStep2:   IS_FR ? 'Port et voyage'                : 'Port & Voyage',
    reviewStep3:   IS_FR ? 'Cas de MIG'                    : 'GI Cases',
    reviewStep4:   IS_FR ? 'Contact'                       : 'Contact'
  };


  // ==========================================================================
  // DOM REFERENCES
  // ==========================================================================

  var $form, form, $btnPrev, $btnNext, $btnSubmit;


  // ==========================================================================
  // LOGGING
  // ==========================================================================

  var LOG = '[GI-v2]';
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
   *   1. Hide all step panels (.step-hidden)
   *   2. Show target step
   *   3. Update progress indicator (active/completed)
   *   4. Show/hide Prev/Next/Submit buttons
   *   5. Update document.title
   *   6. Focus legend for screen reader announcement
   *   7. Push browser history state
   *   8. On Step 5: generate review summary + set timestamp
   *
   * @param {number} step - Step number to show (1-5)
   */
  function showStep(step) {
    // 1-2. Toggle visibility
    $('.step-panel').addClass('step-hidden');
    var $target = $('#step-' + step);
    $target.removeClass('step-hidden');

    // 3. Progress indicator
    $('#gi-progress li').each(function (i) {
      var n = i + 1;
      var $li = $(this);
      $li.removeClass('active completed').removeAttr('aria-current');
      if (n === step) $li.addClass('active').attr('aria-current', 'step');
      else if (n < step) $li.addClass('completed');
    });

    // 4. Button visibility
    $btnPrev.toggle(step > 1);
    $btnNext.toggle(step < TOTAL_STEPS);
    $btnSubmit.toggle(step === TOTAL_STEPS);

    // 5. Page title
    var title = $target.find('legend').first().text().trim();
    document.title = title;

    // 6. Focus management
    var legend = $target.find('legend')[0];
    if (legend) {
      legend.setAttribute('tabindex', '-1');
      legend.focus();
    }

    // 7. Browser history
    if (window.history && window.history.pushState) {
      history.pushState({ step: step }, '', '?step=' + step);
    }

    currentStep = step;
    log.info('Step ' + step);

    // 8. Review step
    if (step === TOTAL_STEPS) {
      generateReviewSummary();
      setSubmitTimestamp();
      assembleDatetime();
    }
  }

  /**
   * Validate the current step before allowing navigation forward.
   *
   * Custom validations run first, then wb-frmvld via $form.valid().
   *
   * @returns {boolean} True if current step passes
   */
  function validateCurrentStep() {
    // Step 2: embarkation ≤ disembarkation
    if (currentStep === 2 && !validateDateComparison()) return false;

    // Step 3: GI case counts ≤ total counts
    if (currentStep === 3 && !validateCaseCounts()) return false;

    // wb-frmvld for everything else
    return $form.valid();
  }


  // ==========================================================================
  // LANGUAGE TOGGLE — FORM STATE PRESERVATION
  // ==========================================================================

  /**
   * Attach click handler to the WET language toggle link.
   */
  function initLanguageToggle() {
    $('#wb-lng a').on('click', function (e) {
      e.preventDefault();
      var targetUrl = $(this).attr('href');

      var state = {
        step: currentStep,
        fields: {},
        radio: {}
      };

      // Capture text/select/textarea values
      $('#gi-report').find(
        'input:not([type="radio"]):not([type="hidden"]), select, textarea'
      ).each(function () {
        if (this.id && this.value) {
          state.fields[this.id] = this.value;
        }
      });

      // Capture checked radio buttons
      $('#gi-report input[type="radio"]:checked').each(function () {
        state.radio[this.name] = this.value;
      });

      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        log.info('Form state saved for language toggle', {
          step: state.step,
          fieldCount: Object.keys(state.fields).length
        });
      } catch (err) {
        log.warn('Failed to save form state', err);
      }

      window.location.href = targetUrl;
    });
  }

  /**
   * On page load, check for saved form state from a language toggle.
   * Restore all field values, trigger conditional logic, navigate to step.
   */
  function restoreFormState() {
    var saved;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return;
    }

    if (!saved) return;
    sessionStorage.removeItem(STORAGE_KEY);

    try {
      var state = JSON.parse(saved);
      log.info('Restoring form state', {
        step: state.step,
        fieldCount: Object.keys(state.fields).length
      });

      // STEP 1: Restore radios FIRST (submitter toggle drives #submitter-section)
      Object.keys(state.radio).forEach(function (name) {
        var radio = document.querySelector(
          'input[name="' + name + '"][value="' + state.radio[name] + '"]'
        );
        if (radio) {
          radio.checked = true;
          $(radio).trigger('change');
        }
      });

      // STEP 2: Wait for CSS transitions (submitter section slideDown)
      setTimeout(function () {

        // STEP 3: Restore text/select values
        Object.keys(state.fields).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) {
            el.value = state.fields[id];
            if (el.tagName === 'SELECT') {
              $(el).trigger('change');
            }
          }
        });

        // STEP 4: Navigate to saved step
        if (state.step && state.step > 1) {
          showStep(state.step);
        }

        log.info('Form state restored');
      }, 300);

    } catch (err) {
      log.error('Failed to restore form state', err);
    }
  }


  // ==========================================================================
  // CONDITIONAL FIELD LOGIC
  // ==========================================================================

  /**
   * Next Port toggle — shows "Other Next Canadian Port" text field when
   * the "Other" option (GUID_OTHER_PORT) is selected.
   */
  function initNextPortToggle() {
    $('#ethi_nextport').on('change', function () {
      toggleConditionalField(
        '#other-port-group',
        '#ethi_othernextcanadianport',
        $(this).val() === GUID_OTHER_PORT
      );
    });
  }

  /**
   * Submitter toggle — shows #submitter-section when "No" (value=0) is
   * selected for "Is the submitter the medical contact?"
   *
   * When "Yes": submitter IS the medical contact → hide submitter fields,
   * strip required from them.
   * When "No": submitter is different → show submitter fields, restore required.
   */
  function initSubmitterToggle() {
    $('input[name="ethi_submitterismedicalcontact"]').on('change', function () {
      var isNo = $(this).val() === '0';
      var $section = $('#submitter-section');

      if (isNo) {
        // Show submitter fields, restore required
        $section.slideDown(200);
        $section.find('[data-was-required]').each(function () {
          $(this).attr('required', 'required').removeAttr('data-was-required');
        });
        // First time: required already in HTML. On subsequent toggles, data-was-required restores it.
        // Ensure required is set on submitter fields that should be required
        $section.find('.form-group label.required').each(function () {
          var $input = $(this).closest('.form-group').find('input, select, textarea');
          $input.attr('required', 'required');
        });
      } else {
        // Hide submitter fields, strip required
        $section.find('[required]').each(function () {
          $(this).removeAttr('required').attr('data-was-required', 'true');
        });
        $section.slideUp(200);
      }
    });
  }

  /**
   * Generic helper to show/hide a form group and manage required.
   */
  function toggleConditionalField(groupSel, fieldSel, show) {
    var $group = $(groupSel);
    var $field = $(fieldSel);
    if (show) {
      $group.show();
      if ($field.attr('data-was-required') === 'true' ||
          $field.closest('.form-group').find('label').hasClass('required')) {
        $field.attr('required', 'required');
      }
    } else {
      $group.hide();
      $field.removeAttr('required').val('');
    }
  }


  // ==========================================================================
  // CUSTOM VALIDATION
  // ==========================================================================

  /**
   * Validate embarkation ≤ disembarkation (Step 2).
   * Both dates are required, so both will be present.
   *
   * @returns {boolean} True if dates are valid
   */
  function validateDateComparison() {
    var embark = document.getElementById('ethi_embarkationdate').value;
    var disembark = document.getElementById('ethi_disembarkationdate').value;

    if (!embark || !disembark) return true;

    if (new Date(embark) > new Date(disembark)) {
      var $g = $('#ethi_embarkationdate').closest('.form-group');
      showFieldError($g, document.getElementById('ethi_embarkationdate'), MSG.dateError);
      return false;
    }
    return true;
  }

  /**
   * Validate GI case counts ≤ total counts (Step 3).
   * Ensures passenger GI cases ≤ total passengers, and
   * crew GI cases ≤ total crew.
   *
   * @returns {boolean} True if counts are valid
   */
  function validateCaseCounts() {
    var totalPax = intVal('ethi_totalnumberofpassengersonboard');
    var paxCases = intVal('ethi_numberofpassengergastrointestinalcases');
    var totalCrew = intVal('ethi_totalnumberofcrewonboard');
    var crewCases = intVal('ethi_numberofcrewgastrointestinalcases');
    var valid = true;

    // Clear previous custom errors
    $('.case-error').remove();
    $('#step-3 .form-group').removeClass('has-error');

    if (paxCases > totalPax) {
      var $g = $('#ethi_numberofpassengergastrointestinalcases').closest('.form-group');
      showFieldError($g, document.getElementById('ethi_numberofpassengergastrointestinalcases'), MSG.paxCaseError);
      valid = false;
    }

    if (crewCases > totalCrew) {
      var $g2 = $('#ethi_numberofcrewgastrointestinalcases').closest('.form-group');
      showFieldError($g2, document.getElementById('ethi_numberofcrewgastrointestinalcases'), MSG.crewCaseError);
      valid = false;
    }

    return valid;
  }

  /**
   * Display a custom error message on a form field.
   */
  function showFieldError($g, el, msg) {
    $g.addClass('has-error');
    var eid = el.id + '-custom-error';
    $g.append(
      '<strong id="' + eid + '" class="case-error error">' +
      '<span class="label label-danger">' + msg + '</span>' +
      '</strong>'
    );
    el.setAttribute('aria-describedby', eid);
    el.setAttribute('aria-invalid', 'true');
  }

  /**
   * Strip non-digit characters from phone inputs.
   */
  function initPhoneStripping() {
    $('input[type="tel"]').on('input', function () {
      this.value = this.value.replace(/\D/g, '');
    });
  }


  // ==========================================================================
  // DATE + TIME ASSEMBLY
  // ==========================================================================

  /**
   * Combine ethi_nextcanadadate and ethi_nextcanadatime into the hidden
   * ethi_nextcanadadateandtimeportal field as an ISO datetime string.
   *
   * Called when Step 5 becomes active.
   */
  function assembleDatetime() {
    var d = val('ethi_nextcanadadate');
    var t = val('ethi_nextcanadatime');
    if (d && t) {
      // Format: "2025-06-15T14:30:00Z"
      document.getElementById('ethi_nextcanadadateandtimeportal').value = d + 'T' + t + ':00Z';
    }
  }


  // ==========================================================================
  // REVIEW SUMMARY (Step 5)
  // ==========================================================================

  /**
   * Build the review summary HTML and inject into #review-content.
   */
  function generateReviewSummary() {
    var html = '';

    // Step 1: Vessel Details
    html += reviewSection(MSG.reviewStep1, [
      rf('ethi_cruiselinename'),
      rf('ethi_vesselname'),
      rf('ethi_imo'),
      rf('ethi_voyagenumber'),
      rf('ethi_captainsname'),
      rf('ethi_captainsemailaddress'),
      rf('ethi_shipphonenumber'),
      rf('ethi_shipfaxnumber')
    ]);

    // Step 2: Port & Voyage
    html += reviewSection(MSG.reviewStep2, [
      rf('ethi_lastport'),
      rlf('ethi_nextport'),
      rf('ethi_othernextcanadianport'),
      rf('ethi_nextcanadadate'),
      rlf('ethi_nextcanadatime'),
      rf('ethi_embarkationdate'),
      rf('ethi_disembarkationdate')
    ]);

    // Step 3: GI Cases
    var rtVal = $('input[name="ethi_reporttype"]:checked');
    var rtLabel = rtVal.length ? rtVal.parent().text().trim() : '';
    var s3 = [];
    if (rtLabel) {
      s3.push({ label: getLabelText('ethi_reporttype_initial', true), value: rtLabel });
    }
    s3.push(
      rf('ethi_totalnumberofpassengersonboard'),
      rf('ethi_numberofpassengergastrointestinalcases'),
      rf('ethi_totalnumberofcrewonboard'),
      rf('ethi_numberofcrewgastrointestinalcases')
    );
    html += reviewSection(MSG.reviewStep3, s3);

    // Step 4: Contact
    var submitterIsContact = $('input[name="ethi_submitterismedicalcontact"]:checked').val();
    var yesNo = submitterIsContact === '1' ? (IS_FR ? 'Oui' : 'Yes') : (IS_FR ? 'Non' : 'No');
    var s4 = [
      rf('ethi_medicalcontactname'),
      rf('ethi_medicalcontacttitle'),
      rf('ethi_medicalcontactemailaddress'),
      rf('ethi_medicalcontactphonenumber'),
      { label: IS_FR ? 'L\'expéditeur est la personne-ressource médicale' : 'Submitter is medical contact', value: yesNo }
    ];
    if (submitterIsContact === '0') {
      s4.push(
        rf('ethi_yourname'),
        rf('ethi_yourtitle'),
        rf('ethi_youremailaddress'),
        rf('ethi_yourphonenumber')
      );
    }
    html += reviewSection(MSG.reviewStep4, s4);

    $('#review-content').html(html);
  }

  /** Build a review section (heading + table). */
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

  /** Review Field — text/number/date input value. */
  function rf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.value } : null;
  }

  /** Review Lookup Field — select's visible text. */
  function rlf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.options[el.selectedIndex].text } : null;
  }

  /**
   * Get label text for a form field.
   * @param {string} id - Element ID
   * @param {boolean} [isRadioGroup] - If true, look at parent fieldset legend
   */
  function getLabelText(id, isRadioGroup) {
    if (isRadioGroup) {
      var $legend = $('#' + id).closest('fieldset').find('legend .field-name, legend .field-label .field-name');
      return $legend.length ? $legend.first().text().trim() : id;
    }
    var $lbl = $('label[for="' + id + '"]');
    if ($lbl.length) {
      var $fn = $lbl.find('.field-name');
      return $fn.length ? $fn.text().trim() : $lbl.text().trim();
    }
    var $legend2 = $('#' + id).closest('fieldset').find('legend .field-name');
    return $legend2.length ? $legend2.text().trim() : id;
  }

  /** Escape HTML to prevent XSS in review summary. */
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }


  // ==========================================================================
  // SUBMIT TIMESTAMP
  // ==========================================================================

  /**
   * Generate UTC timestamp for ethi_submittimeutc.
   * Format: "YYYY-MM-DD HH:MM AM/PM UTC"
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
   * @returns {Promise<string|null>}
   */
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


  // ==========================================================================
  // SUBMISSION — Power Automate Flow
  // ==========================================================================

  /**
   * Build the JSON payload for the Power Automate flow.
   *
   * No file uploads for GI Report (simpler than SSI).
   * The "submitter is medical contact" toggle determines whether
   * submitter fields are included.
   *
   * @returns {Object} JSON payload
   */
  function buildPayload() {
    var submitterIsContact = $('input[name="ethi_submitterismedicalcontact"]:checked').val();
    var nextPortGuid = val('ethi_nextport');

    var payload = {
      // --- Step 1: Vessel Details ---
      ethi_cruiselinename: val('ethi_cruiselinename'),
      ethi_vesselname: val('ethi_vesselname'),
      ethi_imo: val('ethi_imo') || null,
      ethi_voyagenumber: val('ethi_voyagenumber'),
      ethi_captainsname: val('ethi_captainsname'),
      ethi_captainsemailaddress: val('ethi_captainsemailaddress'),
      ethi_shipphonenumber: val('ethi_shipphonenumber'),
      ethi_shipfaxnumber: val('ethi_shipfaxnumber') || null,

      // --- Step 2: Port & Voyage ---
      ethi_lastport: val('ethi_lastport'),
      ethi_nextport_guid: nextPortGuid || null,
      ethi_othernextcanadianport: (nextPortGuid === GUID_OTHER_PORT) ? val('ethi_othernextcanadianport') : null,
      ethi_nextcanadadate: val('ethi_nextcanadadate'),
      ethi_nextcanadatime: val('ethi_nextcanadatime'),
      ethi_nextcanadadateandtimeportal: val('ethi_nextcanadadateandtimeportal') || null,
      ethi_embarkationdate: val('ethi_embarkationdate'),
      ethi_disembarkationdate: val('ethi_disembarkationdate'),

      // --- Step 3: GI Cases ---
      ethi_reporttype: intVal('ethi_reporttype'),
      ethi_totalnumberofpassengersonboard: intVal('ethi_totalnumberofpassengersonboard'),
      ethi_numberofpassengergastrointestinalcases: intVal('ethi_numberofpassengergastrointestinalcases'),
      ethi_totalnumberofcrewonboard: intVal('ethi_totalnumberofcrewonboard'),
      ethi_numberofcrewgastrointestinalcases: intVal('ethi_numberofcrewgastrointestinalcases'),

      // --- Step 4: Contact ---
      ethi_medicalcontactname: val('ethi_medicalcontactname'),
      ethi_medicalcontacttitle: val('ethi_medicalcontacttitle'),
      ethi_medicalcontactemailaddress: val('ethi_medicalcontactemailaddress'),
      ethi_medicalcontactphonenumber: val('ethi_medicalcontactphonenumber'),
      ethi_submitterismedicalcontact: (submitterIsContact === '1'),

      // Submitter fields only when different from medical contact
      ethi_yourname: submitterIsContact === '0' ? val('ethi_yourname') : null,
      ethi_yourtitle: submitterIsContact === '0' ? val('ethi_yourtitle') : null,
      ethi_youremailaddress: submitterIsContact === '0' ? val('ethi_youremailaddress') : null,
      ethi_yourphonenumber: submitterIsContact === '0' ? val('ethi_yourphonenumber') : null,

      // --- System ---
      ethi_submittimeutc: val('ethi_submittimeutc')
    };

    // Handle report type from radio group
    var rtChecked = $('input[name="ethi_reporttype"]:checked').val();
    if (rtChecked) {
      payload.ethi_reporttype = parseInt(rtChecked, 10);
    }

    // Strip nulls and empty strings
    Object.keys(payload).forEach(function (k) {
      if (payload[k] === null || payload[k] === '' || payload[k] === undefined) {
        delete payload[k];
      }
    });

    return payload;
  }

  /**
   * Get trimmed value from a field by ID.
   */
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  /**
   * Get integer value from a field by ID.
   * For radio groups, reads the checked value by name.
   */
  function intVal(id) {
    // Check if this is a radio group (no element with this exact ID may exist)
    var el = document.getElementById(id);
    if (el) return parseInt(el.value, 10) || 0;

    // Try radio by name
    var radio = $('input[name="' + id + '"]:checked');
    if (radio.length) return parseInt(radio.val(), 10) || 0;

    return 0;
  }

  /**
   * Full form submission sequence (no file uploads for GI Report).
   *
   * 1. Disable submit button
   * 2. Get reCAPTCHA token
   * 3. Build JSON payload
   * 4. POST to Power Automate flow
   * 5. Clear sessionStorage, redirect to confirmation
   */
  function handleSubmit() {
    $btnSubmit.prop('disabled', true).text(MSG.submitting);
    log.info('=== Submit ===');

    executeRecaptcha()
      .then(function (token) {
        var payload = buildPayload();
        payload.recaptchaToken = token || '';
        log.debug('Payload', payload);

        return $.ajax({
          url: FLOW_URL,
          type: 'POST',
          contentType: 'application/json',
          data: JSON.stringify(payload)
        });
      })
      .then(function (response) {
        log.info('Record: ' + response.id);
        log.info('=== Complete ===');

        try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }

        window.location.href = CONFIRM_URL;
      })
      .catch(function (err) {
        log.error('Submit failed', err);

        $btnSubmit.prop('disabled', false).text(MSG.submitLabel);

        var $alert = $('<div class="alert alert-danger" role="alert"><p>' + MSG.submitError + '</p></div>');
        $('#review-summary').before($alert);
        $alert[0].setAttribute('tabindex', '-1');
        $alert[0].focus();
        setTimeout(function () { $alert.fadeOut(function () { $alert.remove(); }); }, 10000);
      });
  }


  // ==========================================================================
  // BROWSER HISTORY
  // ==========================================================================

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
   *   2. Attach navigation + submit handlers
   *   3. Initialize conditional logic (Port, Submitter)
   *   4. Initialize input behaviors (phone stripping)
   *   5. Initialize language toggle preservation
   *   6. Initialize browser history handler
   *   7. Show initial step
   *   8. Restore form state from language toggle
   */
  function initialize() {
    log.info('=== Init v2 ===');

    // 1. Cache DOM references
    form = document.getElementById('gi-report');
    $form = $(form);
    $btnPrev = $('#btn-prev');
    $btnNext = $('#btn-next');
    $btnSubmit = $('#btn-submit');

    // 2. Navigation and submit handlers
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

    // 3. Conditional field logic
    initNextPortToggle();
    initSubmitterToggle();

    // 4. Input behaviors
    initPhoneStripping();

    // 5. Language toggle preservation
    initLanguageToggle();

    // 6. Browser history
    initHistoryHandler();

    // 7. Show initial step
    var urlStep = new URLSearchParams(window.location.search).get('step');
    var startStep = (urlStep && parseInt(urlStep, 10) >= 1 && parseInt(urlStep, 10) <= TOTAL_STEPS)
                    ? parseInt(urlStep, 10) : 1;
    showStep(startStep);

    // 8. Restore form state from language toggle
    restoreFormState();

    log.info('=== Ready ===');
  }

  // Wait for WET-BOEW initialization
  $(document).on('wb-ready.wb', function () { initialize(); });

  // Fallback
  if (document.readyState === 'complete') setTimeout(initialize, 100);

})(window, document, jQuery);
