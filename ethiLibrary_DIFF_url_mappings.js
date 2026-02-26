/* ============================================================
   ethiLibrary.js — DIFF: Bilingual URL Mapping Update
   ============================================================
   Location: rewriteLanguageToggle() IIFE, around line 120
   
   FIND this block (old mappings):
   ============================================================ */

// ❌ OLD — REMOVE:
  var mappings = {
    '/en/gi-report/':                                '/fr/Rapport-GI/',
    '/fr/rapport-gi/':                               '/en/GI-Report/',
    '/en/ssi-request/':                              '/fr/Demande-ISN/',
    '/fr/demande-isn/':                              '/en/SSI-Request/',
    '/en/cruise-ship-inspection-scores/':             '/fr/resultats-inspections-navires-croisiere/',
    '/fr/resultats-inspections-navires-croisiere/':   '/en/cruise-ship-inspection-scores/'
  };

/* ============================================================
   REPLACE WITH (Option A bilingual compound slugs):
   ============================================================ */

// ✅ NEW — REPLACE:
  // Option A bilingual compound slugs (same slug in both /en/ and /fr/)
  // See: bilingualurloptions.pdf — recommended approach
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
