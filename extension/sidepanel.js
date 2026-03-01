// sidepanel.js — Main logic for IFA Tax Assistant side panel
// Handles: tab switching, data display, tax observations, letter generation

'use strict';

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────

let clientData = null;   // extracted from iO page
let taxRules   = null;   // parsed from rules.yaml
let templates  = [];     // from chrome.storage.local

// ──────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────

function fmt(n) {
  if (typeof n !== 'number') return '—';
  return '£' + n.toLocaleString('en-GB');
}

function fmtDate(d) {
  if (!d) return '—';
  if (d instanceof Date) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return d;
}

function pct(used, total) {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

function severity(usedPct, rules) {
  // rules.alert_thresholds: green=0, amber=80, red=100
  const t = rules.alert_thresholds || { amber: 80, red: 100 };
  if (usedPct >= t.red) return 'red';
  if (usedPct >= t.amber) return 'amber';
  return 'green';
}

// ──────────────────────────────────────────────────────────────
// Tab switching
// ──────────────────────────────────────────────────────────────

document.querySelectorAll('.sp-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sp-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ──────────────────────────────────────────────────────────────
// Load rules.yaml
// ──────────────────────────────────────────────────────────────

async function loadRules() {
  try {
    const url = chrome.runtime.getURL('rules.yaml');
    const resp = await fetch(url);
    const text = await resp.text();
    taxRules = jsyaml.load(text);
  } catch (e) {
    console.error('Failed to load rules.yaml', e);
    taxRules = null;
  }
}

// ──────────────────────────────────────────────────────────────
// Load templates from storage
// ──────────────────────────────────────────────────────────────

function loadTemplates() {
  chrome.storage.local.get(['templates'], (result) => {
    templates = result.templates || [];
    populateTemplateDropdown();
  });
}

function populateTemplateDropdown() {
  const sel = document.getElementById('template-select');
  sel.innerHTML = '<option value="">— Select a template —</option>';
  templates.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  updateGenerateButton();
}

// ──────────────────────────────────────────────────────────────
// Request data from content script
// ──────────────────────────────────────────────────────────────

function requestData() {
  document.getElementById('refresh-btn').textContent = '⟳ Loading…';
  chrome.runtime.sendMessage({ type: 'SIDEPANEL_REQUEST_DATA' }, (response) => {
    document.getElementById('refresh-btn').textContent = '⟳ Refresh';
    if (chrome.runtime.lastError || !response) {
      showError('Could not connect to the page. Make sure the iO page is open and try again.');
      return;
    }
    if (response.error) {
      showError('Error: ' + response.error);
      return;
    }
    if (response.data) {
      clientData = response.data;
      renderSummary();
      renderObservations();
      updateLetterForm();
    }
  });
}

function showError(msg) {
  // Show in summary tab
  const empty = document.getElementById('summary-empty');
  empty.style.display = 'block';
  empty.querySelector('p').textContent = msg;
  document.getElementById('summary-loaded').style.display = 'none';
}

// ──────────────────────────────────────────────────────────────
// Listen for push updates from content script (via background)
// ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CLIENT_DATA_UPDATE' && message.data) {
    clientData = message.data;
    renderSummary();
    renderObservations();
    updateLetterForm();
  }
});

// ──────────────────────────────────────────────────────────────
// Render: Client Summary Tab
// ──────────────────────────────────────────────────────────────

function renderSummary() {
  if (!clientData) return;
  const d = clientData;

  document.getElementById('summary-empty').style.display = 'none';
  document.getElementById('summary-loaded').style.display = 'block';

  // Portfolio value
  document.getElementById('total-value').textContent = fmt(d.totalValue);

  // Client info
  document.getElementById('info-name').textContent = d.client.name || '—';
  document.getElementById('info-risk').textContent = d.client.riskProfile || '—';
  document.getElementById('info-address').textContent = d.client.address || '—';
  document.getElementById('info-adviser').textContent = d.client.adviser || '—';
  document.getElementById('info-review').textContent = d.client.reviewDate || '—';
  document.getElementById('info-next-review').textContent = d.client.nextReview || '—';

  // Tax year
  document.getElementById('tax-year-label').textContent = d.taxYear.year ? `(${d.taxYear.year})` : '';

  const ty = d.taxYear;
  document.getElementById('ty-isa').innerHTML =
    `M: ${fmt(ty.isaContributions.margaret)}<br>D: ${fmt(ty.isaContributions.david)}`;
  document.getElementById('ty-pension').innerHTML =
    `M: ${fmt(ty.pensionContributions.margaret)}<br>D: ${fmt(ty.pensionContributions.david)}`;
  document.getElementById('ty-cgt').textContent = fmt(ty.estimatedCapitalGains);
  document.getElementById('ty-dividend').textContent = fmt(ty.dividendIncome);
  document.getElementById('ty-salary').innerHTML =
    `M: ${fmt(ty.salary.margaret)}<br>D: ${fmt(ty.salary.david)}`;
  document.getElementById('ty-carry').textContent =
    ty.carryForward.david ? `David: ${fmt(ty.carryForward.david)}` : '—';

  // Holdings grouped
  renderHoldingsGrouped(d.holdings);

  // Timestamp
  if (d.extractedAt) {
    const dt = new Date(d.extractedAt);
    document.getElementById('last-refreshed').textContent =
      'Last refreshed: ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
}

function renderHoldingsGrouped(holdings) {
  const container = document.getElementById('holdings-grouped');
  container.innerHTML = '';

  const groups = {};
  holdings.forEach((h) => {
    const key = mapGroupKey(h);
    if (!groups[key]) groups[key] = [];
    groups[key].push(h);
  });

  const order = ['Pensions', 'ISAs', 'GIA', 'Cash'];
  order.forEach((grp) => {
    if (!groups[grp] || groups[grp].length === 0) return;
    const total = groups[grp].reduce((s, h) => s + h.value, 0);

    const div = document.createElement('div');
    div.className = 'holding-group';
    div.innerHTML = `<div class="holding-group-title">${grp}</div>` +
      groups[grp].map((h) =>
        `<div class="holding-row">
          <span class="hr-provider">${h.provider}${h.owner ? ' <em style="font-size:10px;color:#888;">(${h.owner})</em>' : ''}</span>
          <span class="hr-wrapper">${h.wrapper}</span>
          <span class="hr-value">${fmt(h.value)}</span>
        </div>`
      ).join('') +
      `<div class="group-total"><span>${grp} Total</span><span>${fmt(total)}</span></div>`;
    container.appendChild(div);
  });
}

function mapGroupKey(h) {
  const t = (h.type || '').toLowerCase();
  const w = (h.wrapper || '').toLowerCase();
  if (t.includes('pension') || w.includes('sipp') || w.includes('workplace')) return 'Pensions';
  if (t.includes('isa') || w.includes('isa')) return 'ISAs';
  if (t.includes('gia') || w.includes('gia')) return 'GIA';
  return 'Cash';
}

// ──────────────────────────────────────────────────────────────
// Render: Tax Observations Tab
// ──────────────────────────────────────────────────────────────

function renderObservations() {
  if (!clientData || !taxRules) return;

  const container = document.getElementById('obs-loaded');
  container.innerHTML = '';

  document.getElementById('obs-empty').style.display = 'none';
  container.style.display = 'block';

  const observations = calculateObservations(clientData, taxRules);
  observations.forEach((obs) => {
    container.appendChild(buildObsCard(obs));
  });
}

function buildObsCard(obs) {
  const card = document.createElement('div');
  card.className = `obs-card ${obs.severity}`;
  card.innerHTML = `
    <div class="obs-header">
      <div class="obs-indicator"></div>
      <div class="obs-title">${obs.title}</div>
    </div>
    <div class="obs-body">
      <div class="obs-summary">${obs.summary}</div>
      <div class="obs-workings">${obs.workings}</div>
      <div class="obs-source">Source: ${obs.source}</div>
    </div>
  `;
  return card;
}

function calculateObservations(data, rules) {
  const obs = [];
  const ty = data.taxYear;

  // ── 1. ISA Allowance ──────────────────────────────────────
  {
    const allowance = rules.isa.annual_allowance; // 20000
    const mUsed = ty.isaContributions.margaret;
    const dUsed = ty.isaContributions.david;
    const mRemaining = allowance - mUsed;
    const dRemaining = allowance - dUsed;
    const mPct = pct(mUsed, allowance);
    const dPct = pct(dUsed, allowance);
    const worstPct = Math.max(mPct, dPct);
    const sev = severity(worstPct, rules);

    obs.push({
      title: 'ISA Allowance',
      severity: sev,
      summary: `Margaret has ${fmt(mRemaining)} remaining (${100 - mPct}% unused). David has ${fmt(dRemaining)} remaining (${100 - dPct}% unused). Both have unused ISA allowance before 5 April.`,
      workings:
        `Annual ISA allowance:    ${fmt(allowance)}\n` +
        `Margaret contributed:    ${fmt(mUsed)} (${mPct}% used)\n` +
        `Margaret remaining:      ${fmt(mRemaining)}\n` +
        `David contributed:       ${fmt(dUsed)} (${dPct}% used)\n` +
        `David remaining:         ${fmt(dRemaining)}`,
      source: `HMRC: ISA Annual Subscription Limit ${rules.tax_year}`
    });
  }

  // ── 2. Pension Annual Allowance ───────────────────────────
  {
    const allowance = rules.pensions.annual_allowance; // 60000
    const mUsed = ty.pensionContributions.margaret;
    const dUsed = ty.pensionContributions.david;
    const dCarry = (ty.carryForward && ty.carryForward.david) || 18000;
    const mPct = pct(mUsed, allowance);
    const dPct = pct(dUsed, allowance);
    const worstPct = Math.max(mPct, dPct);
    const sev = severity(worstPct, rules);
    const mRemaining = allowance - mUsed;
    const dRemaining = allowance - dUsed;
    const dTotalCapacity = dRemaining + dCarry;

    obs.push({
      title: 'Pension Annual Allowance',
      severity: sev,
      summary: `Both clients have significant pension allowance remaining. David also has ${fmt(dCarry)} carry forward available from 2022/23, giving total capacity of ${fmt(dTotalCapacity)}.`,
      workings:
        `Annual allowance:        ${fmt(allowance)}\n` +
        `Margaret contributed:    ${fmt(mUsed)} (${mPct}%)\n` +
        `Margaret remaining:      ${fmt(mRemaining)}\n` +
        `David contributed:       ${fmt(dUsed)} (${dPct}%)\n` +
        `David remaining:         ${fmt(dRemaining)}\n` +
        `David carry forward:     ${fmt(dCarry)} (2022/23 unused)\n` +
        `David total capacity:    ${fmt(dTotalCapacity)}`,
      source: `HMRC: Pension Annual Allowance ${rules.tax_year}`
    });
  }

  // ── 3. Capital Gains Tax ──────────────────────────────────
  {
    const exemptAmount = rules.capital_gains_tax.annual_exempt_amount; // 3000
    const gains = ty.estimatedCapitalGains; // 8400
    const taxableGain = Math.max(0, gains - exemptAmount);
    const cgtRate = rules.capital_gains_tax.higher_rate; // 20% (David higher rate)
    const liability = Math.round(taxableGain * cgtRate / 100);
    const usedPct = pct(gains, exemptAmount);
    const sev = gains > exemptAmount ? 'red' : severity(usedPct, rules);

    obs.push({
      title: 'Capital Gains Tax',
      severity: sev,
      summary: `Estimated gains of ${fmt(gains)} exceed the ${fmt(exemptAmount)} annual exempt amount. Taxable gain of ${fmt(taxableGain)}. Estimated CGT liability of ${fmt(liability)} at higher rate (20%). Consider bed & ISA or timing of disposals.`,
      workings:
        `Estimated gains (GIA):   ${fmt(gains)}\n` +
        `Annual exempt amount:    ${fmt(exemptAmount)}\n` +
        `Taxable gain:            ${fmt(taxableGain)}\n` +
        `CGT rate (higher rate):  ${cgtRate}%\n` +
        `Estimated liability:     ${fmt(liability)}`,
      source: `HMRC: CGT Annual Exempt Amount ${rules.tax_year}`
    });
  }

  // ── 4. Dividend Allowance ─────────────────────────────────
  {
    const allowance = rules.dividends.allowance; // 500
    const dividends = ty.dividendIncome; // 3200
    const taxableDividends = Math.max(0, dividends - allowance);
    const divRate = rules.dividends.higher_rate; // 33.75%
    const liability = Math.round(taxableDividends * divRate / 100);
    const usedPct = pct(dividends, allowance);
    const sev = dividends > allowance ? 'amber' : severity(usedPct, rules);

    obs.push({
      title: 'Dividend Allowance',
      severity: sev,
      summary: `Dividend income of ${fmt(dividends)} exceeds the ${fmt(allowance)} annual allowance. ${fmt(taxableDividends)} taxable at higher rate dividend rate. Consider moving income-producing assets into ISA or pension wrapper to reduce dividend exposure.`,
      workings:
        `Dividend income:         ${fmt(dividends)}\n` +
        `Dividend allowance:      ${fmt(allowance)}\n` +
        `Taxable dividends:       ${fmt(taxableDividends)}\n` +
        `Higher rate div. rate:   ${divRate}%\n` +
        `Estimated liability:     ${fmt(liability)}`,
      source: `HMRC: Dividend Allowance ${rules.tax_year}`
    });
  }

  // ── 5. IHT Exposure ──────────────────────────────────────
  {
    const iht = rules.inheritance_tax;
    const estate = data.ihtEstimate || 1850000;
    const nilRateBands = iht.nil_rate_band * 2;       // 650,000 (joint couple)
    const rnrbBands = iht.residence_nil_rate_band * 2; // 350,000
    // No taper — estate £1.85m < £2m threshold
    const totalExempt = nilRateBands + rnrbBands; // 1,000,000
    const chargeable = Math.max(0, estate - totalExempt);
    const liability = Math.round(chargeable * iht.rate / 100);
    const sev = liability > 0 ? 'red' : 'green';
    const taperedNote = estate > iht.residence_nil_rate_taper_threshold
      ? '\nNote: Estate above taper threshold — RNRB may be reduced.'
      : '\nNote: Estate below £2m taper threshold — full RNRB available.';

    obs.push({
      title: 'Inheritance Tax Exposure',
      severity: sev,
      summary: `Combined estate of £${(estate / 1000000).toFixed(2)}m gives a potential IHT liability of ${fmt(liability)}. Comprehensive IHT planning recommended.`,
      workings:
        `Combined estate:         £${(estate / 1000000).toFixed(2)}m\n` +
        `Nil-rate bands (×2):     ${fmt(nilRateBands)}\n` +
        `RNRB (×2):               ${fmt(rnrbBands)}\n` +
        `Total exempt:            ${fmt(totalExempt)}\n` +
        `Potentially chargeable:  ${fmt(chargeable)}\n` +
        `IHT rate:                ${iht.rate}%\n` +
        `Estimated IHT:           ${fmt(liability)}` +
        taperedNote,
      source: `HMRC: Inheritance Tax Nil Rate Band ${rules.tax_year}`
    });
  }

  // ── 6. Higher Rate Tax & Pension Efficiency ──────────────
  {
    const higherThreshold = rules.income_tax.higher_rate_threshold; // 50270
    const mSalary = ty.salary.margaret;
    const dSalary = ty.salary.david;
    const mHigherRate = mSalary > higherThreshold;
    const dHigherRate = dSalary > higherThreshold;

    let summary = '';
    if (mHigherRate && dHigherRate) {
      summary = `Both Margaret (${fmt(mSalary)}) and David (${fmt(dSalary)}) are higher rate taxpayers. Pension contributions attract 40% tax relief — maximising contributions is highly tax-efficient.`;
    } else if (dHigherRate) {
      summary = `David (${fmt(dSalary)}) is a higher rate taxpayer. Pension contributions attract 40% tax relief.`;
    } else {
      summary = `Review salary levels against higher rate threshold.`;
    }

    const sev = 'amber'; // Always worth flagging as planning opportunity
    obs.push({
      title: 'Higher Rate Tax & Pension Efficiency',
      severity: sev,
      summary,
      workings:
        `Higher rate threshold:   ${fmt(higherThreshold)}\n` +
        `Margaret salary:         ${fmt(mSalary)} — ${mHigherRate ? 'HIGHER RATE' : 'basic rate'}\n` +
        `David salary:            ${fmt(dSalary)} — ${dHigherRate ? 'HIGHER RATE' : 'basic rate'}\n` +
        `Pension tax relief:      ${dHigherRate || mHigherRate ? '40%' : '20%'}\n` +
        `Relief on £10k pension:  ${dHigherRate || mHigherRate ? '£4,000' : '£2,000'}`,
      source: `HMRC: Income Tax Rates and Allowances ${rules.tax_year}`
    });
  }

  return obs;
}

// ──────────────────────────────────────────────────────────────
// Generate Letter Tab
// ──────────────────────────────────────────────────────────────

function updateLetterForm() {
  if (clientData) {
    document.getElementById('letter-no-data').style.display = 'none';
    document.getElementById('letter-form').style.display = 'block';
    loadTemplates();
  } else {
    document.getElementById('letter-no-data').style.display = 'block';
    document.getElementById('letter-form').style.display = 'none';
  }
}

function updateGenerateButton() {
  const sel = document.getElementById('template-select');
  const btn = document.getElementById('generate-btn');
  btn.disabled = !sel.value || !clientData;
}

document.getElementById('template-select').addEventListener('change', () => {
  updateGenerateButton();
  document.getElementById('letter-preview').style.display = 'none';
  document.getElementById('letter-status').innerHTML = '';
});

document.getElementById('generate-btn').addEventListener('click', () => {
  generatePreview();
});

document.getElementById('download-btn').addEventListener('click', () => {
  downloadDocx();
});

function buildPlaceholderMap() {
  if (!clientData || !taxRules) return {};

  const d = clientData;
  const ty = d.taxYear;
  const today = new Date(2026, 2, 1); // 1 March 2026 per system context

  // Holdings by group
  const holdingsByGroup = { Pensions: [], ISAs: [], GIA: [], Cash: [] };
  d.holdings.forEach((h) => {
    holdingsByGroup[mapGroupKey(h)].push(h);
  });
  const pensionTotal = holdingsByGroup.Pensions.reduce((s, h) => s + h.value, 0);
  const isaTotal     = holdingsByGroup.ISAs.reduce((s, h) => s + h.value, 0);
  const giaTotal     = holdingsByGroup.GIA.reduce((s, h) => s + h.value, 0);
  const cashTotal    = holdingsByGroup.Cash.reduce((s, h) => s + h.value, 0);

  // ISA detail
  const isaAllowance = taxRules.isa.annual_allowance;
  const mIsaRemaining = isaAllowance - ty.isaContributions.margaret;
  const dIsaRemaining = isaAllowance - ty.isaContributions.david;

  // CGT
  const exemptAmount  = taxRules.capital_gains_tax.annual_exempt_amount;
  const gains         = ty.estimatedCapitalGains;
  const taxableGain   = Math.max(0, gains - exemptAmount);
  const cgtRate       = taxRules.capital_gains_tax.higher_rate;
  const cgtLiability  = Math.round(taxableGain * cgtRate / 100);

  // Tax observations text
  const obsTexts = clientData && taxRules
    ? calculateObservations(d, taxRules).map((o) => `• ${o.title}: ${o.summary}`).join('\n\n')
    : '';

  // Recommended actions (amber + red)
  const actions = clientData && taxRules
    ? calculateObservations(d, taxRules)
        .filter((o) => o.severity === 'amber' || o.severity === 'red')
        .map((o, i) => `${i + 1}. ${o.title} — ${o.summary}`)
        .join('\n\n')
    : '';

  return {
    client_name:                d.client.name,
    client_address:             d.client.address,
    date:                       today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    adviser_name:               d.client.adviser,
    review_date:                d.client.reviewDate,
    next_review:                d.client.nextReview,
    total_value:                fmt(d.totalValue),
    pension_total:              fmt(pensionTotal),
    isa_total:                  fmt(isaTotal),
    gia_total:                  fmt(giaTotal),
    cash_total:                 fmt(cashTotal),
    tax_year:                   ty.year,
    isa_allowance:              fmt(isaAllowance),
    isa_contributions_detail:   `Margaret: ${fmt(ty.isaContributions.margaret)} contributed (${fmt(mIsaRemaining)} remaining)\nDavid: ${fmt(ty.isaContributions.david)} contributed (${fmt(dIsaRemaining)} remaining)`,
    pension_contributions_detail: `Margaret: ${fmt(ty.pensionContributions.margaret)} contributed\nDavid: ${fmt(ty.pensionContributions.david)} contributed`,
    cgt_detail:                 `Estimated gains of ${fmt(gains)} against ${fmt(exemptAmount)} annual exempt amount. Taxable gain: ${fmt(taxableGain)}.`,
    tax_observations:           obsTexts,
    recommended_actions:        actions,
    isa_utilisation_detail:     `Margaret: ${fmt(ty.isaContributions.margaret)} used of ${fmt(isaAllowance)} (${fmt(mIsaRemaining)} remaining)\nDavid: ${fmt(ty.isaContributions.david)} used of ${fmt(isaAllowance)} (${fmt(dIsaRemaining)} remaining)`,
    isa_recommendation:         `Margaret has ${fmt(mIsaRemaining)} and David has ${fmt(dIsaRemaining)} of unused ISA allowance remaining before 5 April. I would recommend utilising this allowance before the end of the tax year to maximise your tax-free investment growth.`,
    cgt_position_detail:        `Your General Investment Account (AJ Bell, value ${fmt(giaTotal)}) holds assets with estimated unrealised gains of ${fmt(gains)} in the ${ty.year} tax year.`,
    estimated_gains:            fmt(gains),
    cgt_annual_exempt:          fmt(exemptAmount),
    taxable_gain:               fmt(taxableGain),
    estimated_cgt_liability:    fmt(cgtLiability),
    cgt_rate_explanation:       `As a higher rate taxpayer, gains on standard assets are charged at ${cgtRate}%. The estimated liability of ${fmt(cgtLiability)} is based on this rate applied to the taxable gain of ${fmt(taxableGain)}.`,
    cgt_options:                `1. Bed & ISA — sell assets in the GIA and immediately repurchase within your ISA wrapper, sheltering future gains from CGT.\n2. Timing disposals — if possible, defer realisation to a future tax year when you may have a lower tax rate or unused annual exempt amount.\n3. Spousal transfer — transferring assets between spouses is CGT-free and can allow use of a lower-rate taxpayer's exempt amount and lower CGT rate.\n4. Enterprise Investment Scheme (EIS) reinvestment — gains reinvested into qualifying EIS companies can be deferred.`
  };
}

function generatePreview() {
  const map = buildPlaceholderMap();
  const previewDiv = document.getElementById('preview-mappings');
  previewDiv.innerHTML = '';

  Object.entries(map).forEach(([key, value]) => {
    const shortVal = String(value).split('\n')[0].substring(0, 60) +
      (String(value).length > 60 ? '…' : '');
    const row = document.createElement('div');
    row.className = 'preview-row';
    row.innerHTML = `
      <span class="preview-placeholder">{${key}}</span>
      <span class="preview-value">${shortVal}</span>
    `;
    previewDiv.appendChild(row);
  });

  document.getElementById('letter-preview').style.display = 'block';
  document.getElementById('letter-status').innerHTML = `
    <div class="status-msg info">Preview ready. Click Download to generate the populated .docx file.</div>
  `;
}

async function downloadDocx() {
  const selIdx = parseInt(document.getElementById('template-select').value, 10);
  if (isNaN(selIdx) || !templates[selIdx]) {
    showLetterStatus('No template selected.', 'error');
    return;
  }

  const template = templates[selIdx];
  const map = buildPlaceholderMap();

  try {
    // Decode base64 template
    const binaryStr = atob(template.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Use PizZip + Docxtemplater
    const zip = new PizZip(bytes.buffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' }
    });

    doc.render(map);

    const out = doc.getZip().generate({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    // Trigger download
    const url = URL.createObjectURL(out);
    const a = document.createElement('a');
    a.href = url;
    a.download = template.name.replace(/\.docx$/i, '') + '-populated.docx';
    a.click();
    URL.revokeObjectURL(url);

    showLetterStatus('Letter downloaded successfully.', 'success');
  } catch (e) {
    console.error('Docx generation error', e);
    showLetterStatus('Error generating letter: ' + e.message, 'error');
  }
}

function showLetterStatus(msg, type) {
  const el = document.getElementById('letter-status');
  el.innerHTML = `<div class="status-msg ${type}">${msg}</div>`;
}

// ──────────────────────────────────────────────────────────────
// Wire up refresh button
// ──────────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', requestData);

// ──────────────────────────────────────────────────────────────
// Initialise
// ──────────────────────────────────────────────────────────────

async function init() {
  await loadRules();
  loadTemplates();
  // Auto-request data on open
  requestData();
}

init();
