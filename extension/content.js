// content.js — Injected into iO pages to extract client data
// Looks for data-field attributes and the holdings table

(function () {
  'use strict';

  function parseAmount(str) {
    if (!str) return 0;
    // Remove £, commas, whitespace
    const cleaned = str.replace(/[£,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  function getText(selector, context) {
    const el = (context || document).querySelector(selector);
    return el ? el.textContent.trim() : '';
  }

  function getField(fieldName, context) {
    const el = (context || document).querySelector(`[data-field="${fieldName}"]`);
    return el ? el.textContent.trim() : '';
  }

  function extractClientData() {
    const data = {};

    // ── Client info ────────────────────────────────────────────────
    data.client = {
      name: getField('client-name'),
      address: getField('client-address'),
      dob: {
        margaret: getField('dob-margaret'),
        david: getField('dob-david')
      },
      adviser: getField('adviser'),
      reviewDate: getField('review-date'),
      nextReview: getField('next-review'),
      riskProfile: getField('risk-profile')
    };

    // ── Holdings table ──────────────────────────────────────────────
    data.holdings = [];
    const rows = document.querySelectorAll('#holdings-body .policy-row');
    rows.forEach((row) => {
      const valueEl = row.querySelector('[data-field="value"]');
      const rawValue = valueEl
        ? parseInt(valueEl.getAttribute('data-raw-value') || '0', 10)
        : parseAmount(getField('value', row));

      data.holdings.push({
        provider: getField('provider', row),
        type: getField('policy-type', row),
        wrapper: getField('wrapper', row),
        owner: row.getAttribute('data-owner') || '',
        value: rawValue,
        status: getField('status', row)
      });
    });

    // ── Total value ────────────────────────────────────────────────
    const totalEl = document.querySelector('[data-field="portfolio-total"]');
    data.totalValue = totalEl
      ? parseInt(totalEl.getAttribute('data-raw-value') || '0', 10)
      : data.holdings.reduce((s, h) => s + h.value, 0);

    // ── Tax year activity ──────────────────────────────────────────
    const taxYearEl = document.querySelector('[data-field="tax-year"]');
    const taxYearText = taxYearEl ? taxYearEl.textContent.trim() : '2025/26 Tax Year';
    const yearMatch = taxYearText.match(/(\d{4}\/\d{2,4})/);

    data.taxYear = {
      year: yearMatch ? yearMatch[1] : '2025/26',
      isaContributions: {
        margaret: parseAmount(getField('isa-contrib-margaret').replace('Margaret:', '')),
        david: parseAmount(getField('isa-contrib-david').replace('David:', ''))
      },
      pensionContributions: {
        margaret: parseAmount(getField('pension-contrib-margaret').replace('Margaret:', '')),
        david: parseAmount(getField('pension-contrib-david').replace('David:', ''))
      },
      estimatedCapitalGains: parseAmount(getField('capital-gains')),
      dividendIncome: parseAmount(getField('dividend-income')),
      salary: {
        margaret: parseAmount(getField('salary-margaret').replace('Margaret:', '')),
        david: parseAmount(getField('salary-david').replace('David:', ''))
      },
      carryForward: {
        david: parseAmount(
          getField('carry-forward-david').replace('David:', '').replace(/[^\d,]/g, '')
        )
      }
    };

    // ── Notes ──────────────────────────────────────────────────────
    data.notes = [];
    document.querySelectorAll('[data-field="note"]').forEach((el) => {
      const text = el.textContent.trim();
      if (text) data.notes.push(text);
    });

    // ── IHT ───────────────────────────────────────────────────────
    const ihtEl = document.querySelector('[data-field="iht-estate"]');
    if (ihtEl) {
      const raw = ihtEl.textContent.replace(/[£m,\s]/gi, '');
      data.ihtEstimate = parseFloat(raw) * 1000000 || 1850000;
    } else {
      data.ihtEstimate = 1850000;
    }

    data.extractedAt = new Date().toISOString();
    return data;
  }

  // Listen for extraction requests from background or side panel
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_DATA') {
      try {
        const data = extractClientData();
        sendResponse({ success: true, data });
        // Also broadcast so any open side panel updates
        chrome.runtime.sendMessage({ type: 'CLIENT_DATA', data });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    return true;
  });

  // Auto-extract on page load and notify side panel if open
  window.addEventListener('load', () => {
    try {
      const data = extractClientData();
      chrome.runtime.sendMessage({ type: 'CLIENT_DATA', data });
    } catch (e) {
      // Side panel may not be open — ignore
    }
  });
})();
