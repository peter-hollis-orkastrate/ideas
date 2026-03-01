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
  const p1 = d.client.person1Name || 'Client 1';
  const p2 = d.client.person2Name || '';
  const isCouple = d.client.clientType === 'couple' && !!p2;

  const p1Init = p1.charAt(0);
  const p2Init = p2.charAt(0);

  document.getElementById('ty-isa').innerHTML = isCouple
    ? `${p1Init}: ${fmt(ty.isaContributions.margaret)}<br>${p2Init}: ${fmt(ty.isaContributions.david)}`
    : fmt(ty.isaContributions.margaret);
  document.getElementById('ty-pension').innerHTML = isCouple
    ? `${p1Init}: ${fmt(ty.pensionContributions.margaret)}<br>${p2Init}: ${fmt(ty.pensionContributions.david)}`
    : fmt(ty.pensionContributions.margaret);
  document.getElementById('ty-cgt').textContent = fmt(ty.estimatedCapitalGains);
  document.getElementById('ty-dividend').textContent = fmt(ty.dividendIncome);
  document.getElementById('ty-salary').innerHTML = isCouple
    ? `${p1Init}: ${fmt(ty.salary.margaret)}<br>${p2Init}: ${fmt(ty.salary.david)}`
    : fmt(ty.salary.margaret);

  const p1Carry = ty.carryForward.margaret;
  const p2Carry = ty.carryForward.david;
  if (p1Carry || p2Carry) {
    const parts = [];
    if (p1Carry) parts.push(`${p1}: ${fmt(p1Carry)}`);
    if (isCouple && p2Carry) parts.push(`${p2}: ${fmt(p2Carry)}`);
    document.getElementById('ty-carry').textContent = parts.join(', ');
  } else {
    document.getElementById('ty-carry').textContent = '—';
  }

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

  // Person names and couple/individual flag
  const p1 = data.client.person1Name || 'Client 1';
  const p2 = data.client.person2Name || '';
  const isCouple = data.client.clientType === 'couple' && !!p2;

  // ── 1. ISA Allowance ──────────────────────────────────────
  {
    const allowance = rules.isa.annual_allowance;
    const p1Used = ty.isaContributions.margaret;
    const p1Remaining = allowance - p1Used;
    const p1Pct = pct(p1Used, allowance);

    let sev, summary, workings;

    if (isCouple) {
      const p2Used = ty.isaContributions.david;
      const p2Remaining = allowance - p2Used;
      const p2Pct = pct(p2Used, allowance);
      const worstPct = Math.max(p1Pct, p2Pct);
      sev = severity(worstPct, rules);

      if (p1Pct >= 100 && p2Pct >= 100) {
        summary = `Both ${p1} and ${p2} have fully used their ${fmt(allowance)} ISA allowance this tax year. No further subscriptions are possible before 5 April.`;
      } else if (p1Pct >= 100) {
        summary = `${p1}'s ISA allowance is fully used. ${p2} has ${fmt(p2Remaining)} (${100 - p2Pct}% unused) remaining before 5 April.`;
      } else if (p2Pct >= 100) {
        summary = `${p2}'s ISA allowance is fully used. ${p1} has ${fmt(p1Remaining)} (${100 - p1Pct}% unused) remaining before 5 April.`;
      } else {
        summary = `${p1} has ${fmt(p1Remaining)} remaining (${100 - p1Pct}% unused). ${p2} has ${fmt(p2Remaining)} remaining (${100 - p2Pct}% unused). Both have unused allowance before 5 April.`;
      }
      workings =
        `Annual ISA allowance:    ${fmt(allowance)}\n` +
        `${p1.padEnd(16)} ${fmt(p1Used)} contributed (${p1Pct}% used)\n` +
        `${('  remaining:').padEnd(16)} ${fmt(p1Remaining)}\n` +
        `${p2.padEnd(16)} ${fmt(p2Used)} contributed (${p2Pct}% used)\n` +
        `${('  remaining:').padEnd(16)} ${fmt(p2Remaining)}`;
    } else {
      sev = severity(p1Pct, rules);
      if (p1Pct >= 100) {
        summary = `${p1}'s ${fmt(allowance)} ISA allowance is fully used. No further subscriptions are possible this tax year.`;
      } else {
        summary = `${p1} has ${fmt(p1Remaining)} remaining (${100 - p1Pct}% unused) before 5 April.`;
      }
      workings =
        `Annual ISA allowance:    ${fmt(allowance)}\n` +
        `${p1} contributed:       ${fmt(p1Used)} (${p1Pct}% used)\n` +
        `Remaining:               ${fmt(p1Remaining)}`;
    }

    obs.push({
      title: 'ISA Allowance',
      severity: sev,
      summary,
      workings,
      source: `HMRC: ISA Annual Subscription Limit ${rules.tax_year}`
    });
  }

  // ── 2. Pension Annual Allowance (with taper check) ────────
  {
    const standardAA = rules.pensions.annual_allowance;
    const taperThreshold = rules.pensions.tapered_annual_allowance;
    const minAA = taperThreshold.minimum_allowance;

    // Calculate effective annual allowance — taper applies if adjustedIncome > £260k
    const adjustedIncome = ty.adjustedIncome;
    let effectiveAA = standardAA;
    let taperNote = '';
    let taperApplied = false;

    if (adjustedIncome && adjustedIncome > taperThreshold.adjusted_income) {
      const reduction = Math.floor((adjustedIncome - taperThreshold.adjusted_income) / 2);
      effectiveAA = Math.max(minAA, standardAA - reduction);
      taperNote = `\nTaper: adjusted income ${fmt(adjustedIncome)} > ${fmt(taperThreshold.adjusted_income)} threshold\n` +
                  `Reduction = (${fmt(adjustedIncome)} − ${fmt(taperThreshold.adjusted_income)}) ÷ 2 = ${fmt(reduction)}\n` +
                  `Effective annual allowance:  ${fmt(effectiveAA)}`;
      taperApplied = true;
    }

    const p1Used = ty.pensionContributions.margaret;
    const p1Remaining = effectiveAA - p1Used;
    const p1Pct = pct(p1Used, effectiveAA);
    const p1Carry = ty.carryForward.margaret || 0;
    const p1Exceeded = p1Used > effectiveAA;

    let sev, summary, workings;

    if (isCouple) {
      const p2Used = ty.pensionContributions.david;
      const p2Remaining = effectiveAA - p2Used;
      const p2Pct = pct(p2Used, effectiveAA);
      const p2Carry = ty.carryForward.david || 0;
      const p2Exceeded = p2Used > effectiveAA;
      const worstPct = Math.max(p1Pct, p2Pct);
      sev = (p1Exceeded || p2Exceeded) ? 'red' : severity(worstPct, rules);

      if (p1Exceeded || p2Exceeded) {
        const exceeded = [];
        if (p1Exceeded) exceeded.push(`${p1} has exceeded by ${fmt(p1Used - effectiveAA)}`);
        if (p2Exceeded) exceeded.push(`${p2} has exceeded by ${fmt(p2Used - effectiveAA)}`);
        summary = `Pension annual allowance exceeded. ${exceeded.join('; ')}. An annual allowance charge may apply — consider carry forward if available.`;
      } else {
        const carryParts = [];
        if (p1Carry) carryParts.push(`${p1}: ${fmt(p1Carry)}`);
        if (p2Carry) carryParts.push(`${p2}: ${fmt(p2Carry)}`);
        summary = `Both clients have pension allowance remaining this year.${carryParts.length ? ` Carry forward available: ${carryParts.join(', ')}.` : ''}`;
      }
      workings =
        `Annual allowance:        ${fmt(effectiveAA)}${taperApplied ? ' (tapered)' : ''}\n` +
        `${p1.padEnd(16)} ${fmt(p1Used)} contributed (${p1Pct}%)${p1Exceeded ? ' ⚠ EXCEEDED' : ''}\n` +
        `${('  remaining:').padEnd(16)} ${fmt(Math.max(0, p1Remaining))}${p1Carry ? `  (carry fwd: ${fmt(p1Carry)})` : ''}\n` +
        `${p2.padEnd(16)} ${fmt(p2Used)} contributed (${p2Pct}%)${p2Exceeded ? ' ⚠ EXCEEDED' : ''}\n` +
        `${('  remaining:').padEnd(16)} ${fmt(Math.max(0, p2Remaining))}${p2Carry ? `  (carry fwd: ${fmt(p2Carry)})` : ''}` +
        taperNote;
    } else {
      sev = p1Exceeded ? 'red' : severity(p1Pct, rules);
      if (p1Exceeded) {
        const excessAmt = p1Used - effectiveAA;
        summary = `${p1}'s pension contributions of ${fmt(p1Used)} exceed the ${taperApplied ? 'tapered ' : ''}annual allowance of ${fmt(effectiveAA)} by ${fmt(excessAmt)}. An annual allowance charge may apply.`;
      } else {
        summary = `${p1} has used ${p1Pct}% of the ${taperApplied ? 'tapered ' : ''}annual allowance. ${fmt(Math.max(0, p1Remaining))} remaining.${p1Carry ? ` Carry forward of ${fmt(p1Carry)} also available.` : ''}`;
      }
      workings =
        `Annual allowance:        ${fmt(effectiveAA)}${taperApplied ? ' (tapered)' : ''}\n` +
        `${p1} contributed:       ${fmt(p1Used)} (${p1Pct}%)${p1Exceeded ? ' ⚠ EXCEEDED' : ''}\n` +
        `Remaining:               ${fmt(Math.max(0, p1Remaining))}${p1Carry ? `  (carry fwd: ${fmt(p1Carry)})` : ''}` +
        taperNote;
    }

    obs.push({
      title: 'Pension Annual Allowance',
      severity: sev,
      summary,
      workings,
      source: `HMRC: Pension Annual Allowance ${rules.tax_year}`
    });
  }

  // ── 3. Capital Gains Tax ──────────────────────────────────
  {
    const exemptAmount = rules.capital_gains_tax.annual_exempt_amount;
    const gains = ty.estimatedCapitalGains;
    const taxableGain = Math.max(0, gains - exemptAmount);

    // Use higher rate unless all income is basic rate
    const higherThreshold = rules.income_tax.higher_rate_threshold;
    const p1AdditionalRate = ty.salary.margaret > rules.income_tax.additional_rate_threshold;
    const p1HigherRate = p1AdditionalRate || ty.salary.margaret > higherThreshold;
    const anyHigherRate = p1HigherRate || (isCouple && ty.salary.david > higherThreshold);

    const cgtRate = anyHigherRate
      ? rules.capital_gains_tax.higher_rate
      : rules.capital_gains_tax.basic_rate;
    const rateLabel = anyHigherRate ? 'higher/additional rate' : 'basic rate';
    const liability = Math.round(taxableGain * cgtRate / 100);
    const usedPct = pct(gains, exemptAmount);
    const sev = gains > exemptAmount ? 'red' : severity(usedPct, rules);

    let summary;
    if (gains === 0) {
      summary = `No estimated capital gains this tax year. Annual exempt amount of ${fmt(exemptAmount)} is fully available.`;
    } else if (taxableGain === 0) {
      summary = `Estimated gains of ${fmt(gains)} are within the ${fmt(exemptAmount)} annual exempt amount. No CGT liability expected.`;
    } else {
      summary = `Estimated gains of ${fmt(gains)} exceed the ${fmt(exemptAmount)} annual exempt amount. Taxable gain of ${fmt(taxableGain)}. Estimated CGT liability of ${fmt(liability)} at ${rateLabel} (${cgtRate}%). Consider bed & ISA or timing of disposals.`;
    }

    obs.push({
      title: 'Capital Gains Tax',
      severity: sev,
      summary,
      workings:
        `Estimated gains (GIA):   ${fmt(gains)}\n` +
        `Annual exempt amount:    ${fmt(exemptAmount)}\n` +
        `Taxable gain:            ${fmt(taxableGain)}\n` +
        `CGT rate (${rateLabel}):  ${cgtRate}%\n` +
        `Estimated liability:     ${fmt(liability)}`,
      source: `HMRC: CGT Annual Exempt Amount ${rules.tax_year}`
    });
  }

  // ── 4. Dividend Allowance ─────────────────────────────────
  {
    const allowance = rules.dividends.allowance;
    const dividends = ty.dividendIncome;
    const taxableDividends = Math.max(0, dividends - allowance);

    // Dividend rate depends on income tax band
    const higherThreshold = rules.income_tax.higher_rate_threshold;
    const additionalThreshold = rules.income_tax.additional_rate_threshold;
    const p1Salary = ty.salary.margaret;
    const divRate = p1Salary > additionalThreshold
      ? rules.dividends.additional_rate
      : p1Salary > higherThreshold
        ? rules.dividends.higher_rate
        : rules.dividends.basic_rate;
    const rateLabel = p1Salary > additionalThreshold ? 'additional rate'
      : p1Salary > higherThreshold ? 'higher rate' : 'basic rate';

    const liability = Math.round(taxableDividends * divRate / 100);
    const usedPct = pct(dividends, allowance);
    const sev = dividends > allowance ? 'amber' : severity(usedPct, rules);

    let summary;
    if (dividends <= allowance) {
      summary = `Dividend income of ${fmt(dividends)} is within the ${fmt(allowance)} annual allowance. ${fmt(allowance - dividends)} of allowance remaining.`;
    } else {
      summary = `Dividend income of ${fmt(dividends)} exceeds the ${fmt(allowance)} allowance. ${fmt(taxableDividends)} taxable at ${rateLabel} dividend rate (${divRate}%). Consider moving income-producing assets into an ISA or pension.`;
    }

    obs.push({
      title: 'Dividend Allowance',
      severity: sev,
      summary,
      workings:
        `Dividend income:         ${fmt(dividends)}\n` +
        `Dividend allowance:      ${fmt(allowance)}\n` +
        `Taxable dividends:       ${fmt(taxableDividends)}\n` +
        `${rateLabel} div. rate:  ${divRate}%\n` +
        `Estimated liability:     ${fmt(liability)}`,
      source: `HMRC: Dividend Allowance ${rules.tax_year}`
    });
  }

  // ── 5. IHT Exposure ───────────────────────────────────────
  {
    const iht = rules.inheritance_tax;
    const estate = data.ihtEstimate || 0;
    const bandCount = isCouple ? 2 : 1;

    const nilRateBands = iht.nil_rate_band * bandCount;
    // RNRB taper: reduced by £1 per £2 estate exceeds £2m
    const fullRnrb = iht.residence_nil_rate_band * bandCount;
    const taperOver = Math.max(0, estate - iht.residence_nil_rate_taper_threshold);
    const rnrbReduction = Math.floor(taperOver / 2);
    const effectiveRnrb = Math.max(0, fullRnrb - rnrbReduction);
    const totalExempt = nilRateBands + effectiveRnrb;
    const chargeable = Math.max(0, estate - totalExempt);
    const liability = Math.round(chargeable * iht.rate / 100);
    const sev = liability > 0 ? 'red' : 'green';

    const estateStr = estate >= 1000000
      ? `£${(estate / 1000000).toFixed(2)}m`
      : fmt(estate);
    const entityLabel = isCouple ? 'Combined estate' : 'Estate';
    const nrbLabel = isCouple ? `Nil-rate bands (×2):` : `Nil-rate band:`;
    const rnrbLabel = isCouple ? `RNRB (×2):` : `RNRB:`;

    let rnrbNote = '';
    if (rnrbReduction > 0) {
      rnrbNote = `\nRNRB taper: estate ${estateStr} > ${fmt(iht.residence_nil_rate_taper_threshold)}\n` +
                 `Reduction = (${estateStr} − £2m) ÷ 2 = ${fmt(rnrbReduction)}\n` +
                 `Effective RNRB:          ${fmt(effectiveRnrb)}`;
    }

    let summary;
    if (liability === 0) {
      summary = `${entityLabel} of ${estateStr} is within the available nil-rate bands (${fmt(totalExempt)}). No IHT liability expected.`;
    } else {
      summary = `${entityLabel} of ${estateStr} gives a potential IHT liability of ${fmt(liability)}. ${rnrbReduction > 0 ? 'RNRB is reduced by the estate taper. ' : ''}IHT planning recommended.`;
    }

    obs.push({
      title: 'Inheritance Tax Exposure',
      severity: sev,
      summary,
      workings:
        `${entityLabel}:          ${estateStr}\n` +
        `${nrbLabel.padEnd(25)}${fmt(nilRateBands)}\n` +
        `${rnrbLabel.padEnd(25)}${fmt(effectiveRnrb)}${rnrbReduction > 0 ? ' (tapered)' : ''}\n` +
        `Total exempt:            ${fmt(totalExempt)}\n` +
        `Potentially chargeable:  ${fmt(chargeable)}\n` +
        `IHT rate:                ${iht.rate}%\n` +
        `Estimated IHT:           ${fmt(liability)}` +
        rnrbNote,
      source: `HMRC: Inheritance Tax Nil Rate Band ${rules.tax_year}`
    });
  }

  // ── 6. Income Tax Band & Pension Efficiency ───────────────
  {
    const higherThreshold   = rules.income_tax.higher_rate_threshold;   // 50,270
    const additionalThreshold = rules.income_tax.additional_rate_threshold; // 125,140
    const p1Salary = ty.salary.margaret;
    const p2Salary = isCouple ? ty.salary.david : 0;

    const band = (salary) => {
      if (salary > additionalThreshold) return 'additional rate (45%)';
      if (salary > higherThreshold)     return 'higher rate (40%)';
      return 'basic rate (20%)';
    };
    const relief = (salary) => {
      if (salary > additionalThreshold) return 45;
      if (salary > higherThreshold)     return 40;
      return 20;
    };
    const p1Band = band(p1Salary);
    const p1Relief = relief(p1Salary);

    const anyAdditionalRate = p1Salary > additionalThreshold ||
      (isCouple && p2Salary > additionalThreshold);
    const anyHigherRate = anyAdditionalRate ||
      p1Salary > higherThreshold ||
      (isCouple && p2Salary > higherThreshold);

    const sev = anyAdditionalRate ? 'red' : anyHigherRate ? 'amber' : 'green';

    let summary, workingsLines;

    if (isCouple) {
      const p2Band = band(p2Salary);
      const p2Relief = relief(p2Salary);
      summary = `${p1} is a ${p1Band} taxpayer (${p1Relief}% pension relief). ${p2} is a ${p2Band} taxpayer (${p2Relief}% pension relief).`;
      if (anyAdditionalRate) {
        summary += ` Additional rate taxpayers should consider maximising pension contributions before adjusted income exceeds tapered allowance thresholds.`;
      } else if (anyHigherRate) {
        summary += ` Higher rate pension relief means every £10,000 of pension contribution costs only £6,000 net.`;
      } else {
        summary += ` Both are basic rate — pension contributions attract 20% relief (£2,000 for every £10,000 contributed).`;
      }
      workingsLines =
        `Higher rate threshold:   ${fmt(higherThreshold)}\n` +
        `Additional rate:         ${fmt(additionalThreshold)}\n` +
        `${p1.padEnd(16)} ${fmt(p1Salary)} — ${p1Band}\n` +
        `${p2.padEnd(16)} ${fmt(p2Salary)} — ${p2Band}\n` +
        `${p1} pension relief:   ${p1Relief}% (£${p1Relief * 100}/£10k)\n` +
        `${p2} pension relief:   ${p2Relief}% (£${p2Relief * 100}/£10k)`;
    } else {
      summary = `${p1} is a ${p1Band} taxpayer.`;
      if (p1Salary > additionalThreshold) {
        summary += ` Pension contributions attract up to 45% tax relief. Consider the tapered annual allowance if adjusted income exceeds £260,000.`;
      } else if (p1Salary > higherThreshold) {
        summary += ` Pension contributions attract 40% relief — every £10,000 contributed costs £6,000 net.`;
      } else {
        summary += ` Pension contributions attract 20% basic rate relief.`;
      }
      workingsLines =
        `Higher rate threshold:   ${fmt(higherThreshold)}\n` +
        `Additional rate:         ${fmt(additionalThreshold)}\n` +
        `${p1} salary:            ${fmt(p1Salary)} — ${p1Band}\n` +
        `Pension tax relief:      ${p1Relief}%\n` +
        `Relief on £10k pension:  £${p1Relief * 100}`;
    }

    obs.push({
      title: 'Income Tax Band & Pension Efficiency',
      severity: sev,
      summary,
      workings: workingsLines,
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

    // Use PizZip + docxtemplater (lowercase — that's how the bundle exports)
    const zip = new PizZip(bytes.buffer);
    const doc = new docxtemplater(zip, {
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
