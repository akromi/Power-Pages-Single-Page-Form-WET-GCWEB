// ============================================================================
// SSI Request - Single Page Form Controller (v2)
// ============================================================================
// v2 Changes:
//   - Removed client-side lookup loading (countries/provinces now server-side)
//   - Added language toggle form state preservation (sessionStorage)
//   - Submission now goes through Power Automate flow (not direct /_api/)
//   - reCAPTCHA validated server-side by the flow
// ============================================================================

(function (window, document, $) {
  'use strict';

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  var TOTAL_STEPS = 5;
  var currentStep = 1;

  // Config injected by Liquid template via window.SSI_CONFIG
  var CFG = window.SSI_CONFIG || {};
  var IS_FR = CFG.isFr || false;
  var FLOW_URL = CFG.flowUrl || '';
  var CONFIRM_URL = IS_FR ? (CFG.confirmUrlFr || '/fr/demande-ssi/confirmation/') : (CFG.confirmUrlEn || '/en/ssi-request/confirmation/');

  // GUIDs
  var GUID_CANADA = 'f23dc860-6f39-ef11-a317-000d3af44283';
  var GUID_OTHER_REGISTRY = 'f8fad702-0328-ef11-840a-000d3af40fa9';

  // File upload constraints
  var FILE_MAX_BYTES = 4 * 1024 * 1024;
  var FILE_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif'];

  // Session storage key for language toggle persistence
  var STORAGE_KEY = 'ssi-form-state';

  // Bilingual strings
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
    langWarning:    IS_FR ? 'Vos données de formulaire seront conservées.' : 'Your form data will be preserved.',
    reviewStep1:    IS_FR ? 'Agence maritime'               : 'Shipping Agency',
    reviewStep2:    IS_FR ? 'Facturation'                   : 'Invoicing',
    reviewStep3:    IS_FR ? 'Navire'                        : 'Vessel',
    reviewStep4:    IS_FR ? 'Service'                       : 'Service'
  };

  // DOM references
  var $form, form, $btnPrev, $btnNext, $btnSubmit;


  // ==========================================================================
  // LOGGING
  // ==========================================================================

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

  function showStep(step) {
    $('.step-panel').addClass('step-hidden');
    var $target = $('#step-' + step);
    $target.removeClass('step-hidden');

    // Progress indicator
    $('#ssi-progress li').each(function (i) {
      var n = i + 1;
      var $li = $(this);
      $li.removeClass('active completed').removeAttr('aria-current');
      if (n === step) $li.addClass('active').attr('aria-current', 'step');
      else if (n < step) $li.addClass('completed');
    });

    // Nav buttons
    $btnPrev.toggle(step > 1);
    $btnNext.toggle(step < TOTAL_STEPS);
    $btnSubmit.toggle(step === TOTAL_STEPS);

    // Page title
    var title = $target.find('legend').first().text().trim();
    document.title = title;

    // Focus management — move to legend for screen readers
    var legend = $target.find('legend')[0];
    if (legend) {
      legend.setAttribute('tabindex', '-1');
      legend.focus();
    }

    // History API
    if (window.history && window.history.pushState) {
      history.pushState({ step: step }, '', '?step=' + step);
    }

    currentStep = step;
    log.info('Step ' + step);

    // Review + timestamp on final step
    if (step === TOTAL_STEPS) {
      generateReviewSummary();
      setSubmitTimestamp();
    }
  }

  function validateCurrentStep() {
    if (!validateFiles()) return false;
    if (currentStep === 4 && !validateDateComparison()) return false;
    return $form.valid();
  }


  // ==========================================================================
  // LANGUAGE TOGGLE — FORM STATE PRESERVATION
  // ==========================================================================

  /**
   * Intercept the WET language toggle link.
   * Save all form state to sessionStorage before navigating.
   */
  function initLanguageToggle() {
    $('#wb-lng a').on('click', function (e) {
      e.preventDefault();
      var targetUrl = $(this).attr('href');

      var state = {
        step: currentStep,
        fields: {},
        radio: {},
        files: {}
      };

      // Text, email, tel, date, number, textarea, select inputs
      $('#ssi-request').find(
        'input:not([type="file"]):not([type="radio"]):not([type="hidden"]), select, textarea'
      ).each(function () {
        if (this.id && this.value) {
          state.fields[this.id] = this.value;
        }
      });

      // Radio buttons — store checked value by name
      $('#ssi-request input[type="radio"]:checked').each(function () {
        state.radio[this.name] = this.value;
      });

      // File inputs — store filename only (can't persist actual file)
      $('#ssi-request input[type="file"]').each(function () {
        if (this.files && this.files[0]) {
          state.files[this.id] = this.files[0].name;
        }
      });

      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        log.info('Form state saved for language toggle', { step: state.step, fieldCount: Object.keys(state.fields).length });
      } catch (err) {
        log.warn('Failed to save form state', err);
      }

      // Navigate to the other-language page
      window.location.href = targetUrl;
    });
  }

  /**
   * On page load, check for saved form state from a language toggle.
   * Restore field values, trigger conditional logic, navigate to saved step.
   */
  function restoreFormState() {
    var saved;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return; // sessionStorage not available
    }

    if (!saved) return;

    // Remove immediately — one-time use
    sessionStorage.removeItem(STORAGE_KEY);

    try {
      var state = JSON.parse(saved);
      log.info('Restoring form state', { step: state.step, fieldCount: Object.keys(state.fields).length });

      // 1. Restore radio buttons FIRST (CCG toggle drives visibility)
      Object.keys(state.radio).forEach(function (name) {
        var radio = document.querySelector(
          'input[name="' + name + '"][value="' + state.radio[name] + '"]'
        );
        if (radio) {
          radio.checked = true;
          $(radio).trigger('change');
        }
      });

      // Small delay to let conditional sections animate open
      setTimeout(function () {

        // 2. Restore text/select/textarea values
        Object.keys(state.fields).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) {
            el.value = state.fields[id];
            // Trigger change for selects (country → province/state toggle)
            if (el.tagName === 'SELECT') {
              $(el).trigger('change');
            }
          }
        });

        // 3. Handle file inputs — can't restore files, show warning
        Object.keys(state.files).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) {
            var $group = $(el).closest('.form-group');
            // Remove existing warnings
            $group.find('.file-reselect-warning').remove();
            // Add warning
            $group.append(
              '<p class="text-warning file-reselect-warning">' +
              '<span class="glyphicon glyphicon-exclamation-sign" aria-hidden="true"></span> ' +
              MSG.fileReselect +
              '<strong>' + escapeHtml(state.files[id]) + '</strong>' +
              MSG.fileReselect2 +
              '</p>'
            );
            // Temporarily remove required so user can navigate without re-uploading immediately
            if (el.hasAttribute('required')) {
              el.removeAttribute('required');
              el.setAttribute('data-file-was-required', 'true');
            }
          }
        });

        // 4. Navigate to saved step
        if (state.step && state.step > 1) {
          showStep(state.step);
        }

        log.info('Form state restored');
      }, 300); // Delay for CSS transitions on conditional sections

    } catch (err) {
      log.error('Failed to restore form state', err);
    }
  }

  /**
   * Re-apply required to file inputs when user selects a new file
   * (cleans up after language toggle restore)
   */
  function initFileRequiredRestore() {
    $('#ssi-request input[type="file"]').on('change', function () {
      if (this.getAttribute('data-file-was-required') === 'true') {
        this.setAttribute('required', 'required');
        this.removeAttribute('data-file-was-required');
      }
      // Remove the reselect warning
      $(this).closest('.form-group').find('.file-reselect-warning').remove();
    });
  }


  // ==========================================================================
  // CONDITIONAL FIELD LOGIC
  // ==========================================================================

  function initCCGToggle() {
    $('input[name="ethi_canadiancoastguard"]').on('change', function () {
      var isYes = $(this).val() === 'true';
      var $section = $('#invoice-section');

      if (isYes) {
        $section.slideUp(200);
        $section.find('[required]').each(function () {
          $(this).removeAttr('required').attr('data-was-required', 'true');
        });
      } else {
        $section.slideDown(200);
        $section.find('[data-was-required]').each(function () {
          $(this).attr('required', 'required').removeAttr('data-was-required');
        });
      }
    });
  }

  function initCountryToggle() {
    $('#ethi_invoicecountry').on('change', function () {
      var isCanada = ($(this).val() === GUID_CANADA);
      toggleConditionalField('#invoice-province-group', '#ethi_invoiceprovince', isCanada);
      toggleConditionalField('#invoice-state-group', '#ethi_invoiceprovincestate', !isCanada);
      toggleConditionalField('#invoice-postalcode-group', '#ethi_invoicepostalcode', isCanada);
      toggleConditionalField('#invoice-zipcode-group', '#ethi_invoicepostalcodezipcode', !isCanada);
    });
  }

  function initRegistryFlagToggle() {
    $('#ethi_flaginregistry').on('change', function () {
      toggleConditionalField('#other-registry-group', '#ethi_otherregistryflag', $(this).val() === GUID_OTHER_REGISTRY);
    });
  }

  function toggleConditionalField(groupSel, fieldSel, show) {
    var $group = $(groupSel);
    var $field = $(fieldSel);
    if (show) {
      $group.show();
      if ($field.attr('data-was-required') === 'true' || $field.closest('.form-group').find('label').hasClass('required')) {
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
      $g.find('.file-error').remove();
      $g.removeClass('has-error');

      if (cfg.req && !file) return; // wb-frmvld handles required

      if (file) {
        var ext = file.name.split('.').pop().toLowerCase();
        if (file.size === 0) { showFieldError($g, el, MSG.fileEmpty); valid = false; }
        else if (file.size > FILE_MAX_BYTES) { showFieldError($g, el, MSG.fileTooLarge); valid = false; }
        else if (FILE_ALLOWED_EXT.indexOf(ext) === -1) { showFieldError($g, el, MSG.fileWrongType); valid = false; }
      }
    });
    return valid;
  }

  function validateDateComparison() {
    var a = document.getElementById('ethi_vesselexpectedarrivaldate').value;
    var d = document.getElementById('ethi_vesselexpecteddeparturedate').value;
    if (!a || !d) return true;
    if (new Date(a) > new Date(d)) {
      var $g = $('#ethi_vesselexpectedarrivaldate').closest('.form-group');
      showFieldError($g, document.getElementById('ethi_vesselexpectedarrivaldate'), MSG.dateError);
      return false;
    }
    return true;
  }

  function showFieldError($g, el, msg) {
    $g.addClass('has-error');
    var eid = el.id + '-file-error';
    $g.append('<strong id="' + eid + '" class="file-error error"><span class="label label-danger">' + msg + '</span></strong>');
    el.setAttribute('aria-describedby', eid);
    el.setAttribute('aria-invalid', 'true');
  }

  function initPhoneStripping() {
    $('input[type="tel"]').on('input', function () {
      this.value = this.value.replace(/\D/g, '');
    });
  }


  // ==========================================================================
  // REVIEW SUMMARY
  // ==========================================================================

  function generateReviewSummary() {
    var html = '';

    html += reviewSection(MSG.reviewStep1, [
      rf('ethi_nameofshippingagentcompany'), rf('ethi_firstnameofshippingagentrequestingservices'),
      rf('ethi_lastnameofshippingagentrequestingservices'), rf('ethi_organizationphone'),
      rf('ethi_organizationphoneextension'), rf('ethi_secondaryphone'), rf('ethi_organizationemail')
    ]);

    var ccg = $('input[name="ethi_canadiancoastguard"]:checked').val();
    var ccgLabel = ccg === 'true' ? (IS_FR ? 'Oui' : 'Yes') : (IS_FR ? 'Non' : 'No');
    var s2 = [{ label: IS_FR ? 'Garde côtière canadienne' : 'Canadian Coast Guard', value: ccgLabel }];
    if (ccg === 'false') {
      s2.push(rf('ethi_invoicingname'), rlf('ethi_invoicecountry'), rlf('ethi_invoiceprovince'),
        rf('ethi_invoiceprovincestate'), rf('ethi_invoicecity'), rf('ethi_invoiceaddressline1'),
        rf('ethi_invoiceaddressline2'), rf('ethi_invoicepostalcode'), rf('ethi_invoicepostalcodezipcode'),
        rf('ethi_businessnumber'), rf('ethi_isorganizationnumber'), rf('ethi_isreferencenumber'));
    }
    html += reviewSection(MSG.reviewStep2, s2);

    html += reviewSection(MSG.reviewStep3, [
      rf('ethi_shipname'), rf('ethi_vesselname'), rf('ethi_imoregistrationnumber'),
      rf('ethi_callsign'), rf('ethi_portofregistry'), rf('ethi_nettonnage'),
      rf('ethi_numberofholds'), rf('ethi_typeofcargo'), rf('ethi_shipowner'),
      rlf('ethi_flaginregistry'), rf('ethi_otherregistryflag'),
      rff('ethi_uploadshipparticulars'), rff('ethi_existingssc')
    ]);

    html += reviewSection(MSG.reviewStep4, [
      rlf('ethi_serviceprovince'), rf('ethi_servicecityname'), rf('ethi_servicelocation'),
      rf('ethi_dock'), rf('ethi_vesselexpectedarrivaldate'), rf('ethi_vesselexpecteddeparturedate'),
      rf('ethi_previousportofcall'), rf('ethi_nextportofcall'),
      rf('ethi_certificatesexpiresdate'), rf('ethi_additionalcomments')
    ]);

    $('#review-content').html(html);
  }

  function reviewSection(title, fields) {
    var rows = '';
    fields.forEach(function (f) {
      if (f && f.value) rows += '<tr><th scope="row">' + f.label + '</th><td>' + escapeHtml(f.value) + '</td></tr>';
    });
    if (!rows) return '';
    return '<h3>' + title + '</h3><table class="table table-striped table-condensed"><tbody>' + rows + '</tbody></table>';
  }

  // rf = review field, rlf = review lookup field, rff = review file field
  function rf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.value } : null;
  }
  function rlf(id) {
    var el = document.getElementById(id);
    return (el && el.value) ? { label: getLabelText(id), value: el.options[el.selectedIndex].text } : null;
  }
  function rff(id) {
    var el = document.getElementById(id);
    return (el && el.files && el.files[0]) ? { label: getLabelText(id), value: el.files[0].name } : null;
  }

  function getLabelText(id) {
    var $lbl = $('label[for="' + id + '"]');
    if ($lbl.length) {
      var $fn = $lbl.find('.field-name');
      return $fn.length ? $fn.text().trim() : $lbl.text().trim();
    }
    var $legend = $('#' + id).closest('fieldset').find('legend .field-name');
    return $legend.length ? $legend.text().trim() : id;
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }


  // ==========================================================================
  // SUBMIT TIMESTAMP
  // ==========================================================================

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

  function executeRecaptcha() {
    return new Promise(function (resolve) {
      if (!window.grecaptcha) { resolve(null); return; }
      grecaptcha.ready(function () {
        grecaptcha.execute('YOUR_SITE_KEY', { action: 'ssi_submit' })
          .then(resolve)
          .catch(function () { resolve(null); });
      });
    });
  }


  // ==========================================================================
  // SUBMISSION — via Power Automate flow
  // ==========================================================================

  function buildPayload() {
    var ccg = $('input[name="ethi_canadiancoastguard"]:checked').val();
    var countryGuid = val('ethi_invoicecountry');
    var flagGuid = val('ethi_flaginregistry');
    var serviceProv = val('ethi_serviceprovince');

    var payload = {
      // Step 1
      ethi_nameofshippingagentcompany: val('ethi_nameofshippingagentcompany'),
      ethi_firstnameofshippingagentrequestingservices: val('ethi_firstnameofshippingagentrequestingservices'),
      ethi_lastnameofshippingagentrequestingservices: val('ethi_lastnameofshippingagentrequestingservices'),
      ethi_organizationphone: val('ethi_organizationphone'),
      ethi_organizationphoneextension: val('ethi_organizationphoneextension'),
      ethi_secondaryphone: val('ethi_secondaryphone'),
      ethi_organizationemail: val('ethi_organizationemail'),

      // Step 2
      ethi_canadiancoastguard: (ccg === 'true'),
      ethi_invoicingname: ccg === 'false' ? val('ethi_invoicingname') : null,
      ethi_invoiceaddressline1: ccg === 'false' ? val('ethi_invoiceaddressline1') : null,
      ethi_invoiceaddressline2: ccg === 'false' ? val('ethi_invoiceaddressline2') : null,
      ethi_invoicecity: ccg === 'false' ? val('ethi_invoicecity') : null,
      ethi_invoicecountry_guid: ccg === 'false' ? countryGuid : null,
      ethi_invoiceprovince_guid: (ccg === 'false' && countryGuid === GUID_CANADA) ? val('ethi_invoiceprovince') : null,
      ethi_invoiceprovincestate: (ccg === 'false' && countryGuid !== GUID_CANADA) ? val('ethi_invoiceprovincestate') : null,
      ethi_invoicepostalcode: (ccg === 'false' && countryGuid === GUID_CANADA) ? val('ethi_invoicepostalcode') : null,
      ethi_invoicepostalcodezipcode: (ccg === 'false' && countryGuid !== GUID_CANADA) ? val('ethi_invoicepostalcodezipcode') : null,
      ethi_businessnumber: ccg === 'false' ? val('ethi_businessnumber') : null,
      ethi_isorganizationnumber: ccg === 'false' ? val('ethi_isorganizationnumber') : null,
      ethi_isreferencenumber: ccg === 'false' ? val('ethi_isreferencenumber') : null,

      // Step 3
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

      // Step 4
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

      // System
      ethi_submittimeutc: val('ethi_submittimeutc')
    };

    // Strip nulls and empty strings
    Object.keys(payload).forEach(function (k) {
      if (payload[k] === null || payload[k] === '' || payload[k] === undefined) delete payload[k];
    });

    return payload;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  /**
   * Upload file to Dataverse file column via Web API
   * (Requires minimal Update-only table permission on file columns)
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
            '__RequestVerificationToken': $('input[name="__RequestVerificationToken"]').val(),
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
   * Full submission flow:
   * 1. reCAPTCHA token
   * 2. POST to Power Automate flow (validates + creates record)
   * 3. Upload files directly to Dataverse file columns
   * 4. Redirect to confirmation
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
        var recordId = response.id;
        log.info('Record: ' + recordId);

        // Upload files (parallel) — uses scoped Update-only permission
        return Promise.all([
          uploadFile(recordId, 'ethi_uploadshipparticulars', 'ethi_uploadshipparticulars'),
          uploadFile(recordId, 'ethi_existingssc', 'ethi_existingssc')
        ]);
      })
      .then(function () {
        log.info('=== Complete ===');
        // Clean up any saved state
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
  // HISTORY API
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

  function initialize() {
    log.info('=== Init v2 ===');

    form = document.getElementById('ssi-request');
    $form = $(form);
    $btnPrev = $('#btn-prev');
    $btnNext = $('#btn-next');
    $btnSubmit = $('#btn-submit');

    // Navigation
    $btnNext.on('click', function () { if (validateCurrentStep()) showStep(currentStep + 1); });
    $btnPrev.on('click', function () { showStep(currentStep - 1); });
    form.addEventListener('submit', function (e) { e.preventDefault(); if (validateCurrentStep()) handleSubmit(); });

    // Conditional logic
    initCCGToggle();
    initCountryToggle();
    initRegistryFlagToggle();

    // Input behavior
    initPhoneStripping();
    initFileRequiredRestore();

    // Language toggle persistence
    initLanguageToggle();

    // Browser history
    initHistoryHandler();

    // Set initial step
    var urlStep = new URLSearchParams(window.location.search).get('step');
    var startStep = (urlStep && parseInt(urlStep, 10) >= 1 && parseInt(urlStep, 10) <= TOTAL_STEPS)
                    ? parseInt(urlStep, 10) : 1;
    showStep(startStep);

    // Restore form state from language toggle (runs after showStep)
    restoreFormState();

    log.info('=== Ready ===');
  }

  // WET ready event
  $(document).on('wb-ready.wb', function () { initialize(); });
  if (document.readyState === 'complete') setTimeout(initialize, 100);

})(window, document, jQuery);
