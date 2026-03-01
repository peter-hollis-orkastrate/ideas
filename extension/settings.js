// settings.js — Template management page logic

'use strict';

let templates = [];

// ──────────────────────────────────────────────────────────────
// Load templates from storage
// ──────────────────────────────────────────────────────────────

function loadAndRender() {
  chrome.storage.local.get(['templates'], (result) => {
    templates = result.templates || [];
    renderTable();
  });
}

function saveTemplates(callback) {
  chrome.storage.local.set({ templates }, callback);
}

// ──────────────────────────────────────────────────────────────
// Render templates table
// ──────────────────────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById('templates-tbody');
  const empty = document.getElementById('templates-empty');
  tbody.innerHTML = '';

  if (templates.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  templates.forEach((t, i) => {
    const tr = document.createElement('tr');
    const sizeStr = formatBytes(t.size || 0);
    const dateStr = t.addedAt ? new Date(t.addedAt).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    }) : '—';
    const builtIn = t.builtIn ? '<span class="built-in-badge">Built-in</span>' : '';

    tr.innerHTML = `
      <td>
        <div class="template-name">${escapeHtml(t.name)} ${builtIn}</div>
        <div class="template-meta">${escapeHtml(t.filename || t.name)}</div>
      </td>
      <td style="color:#666; font-size:12px;">${sizeStr}</td>
      <td style="color:#666; font-size:12px;">${dateStr}</td>
      <td style="text-align:right;">
        <button class="btn btn-danger btn-sm" data-index="${i}">Remove</button>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Wire remove buttons
  tbody.querySelectorAll('.btn-danger').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      removeTemplate(idx);
    });
  });
}

function removeTemplate(idx) {
  const name = templates[idx] ? templates[idx].name : 'this template';
  if (!confirm(`Remove "${name}"? This cannot be undone.`)) return;
  templates.splice(idx, 1);
  saveTemplates(() => {
    renderTable();
    showStatus(`Template removed.`, 'info');
  });
}

// ──────────────────────────────────────────────────────────────
// Add template via file picker
// ──────────────────────────────────────────────────────────────

document.getElementById('add-template-btn').addEventListener('click', () => {
  document.getElementById('template-file-input').click();
});

document.getElementById('template-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.endsWith('.docx')) {
    showStatus('Please select a .docx file.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (evt) => {
    const base64 = btoa(
      new Uint8Array(evt.target.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
    const displayName = file.name.replace(/\.docx$/i, '').replace(/[-_]/g, ' ');

    templates.push({
      name: displayName,
      filename: file.name,
      data: base64,
      size: file.size,
      addedAt: new Date().toISOString(),
      builtIn: false
    });

    saveTemplates(() => {
      renderTable();
      showStatus(`Template "${displayName}" added successfully.`, 'success');
    });
  };
  reader.readAsArrayBuffer(file);

  // Reset input so same file can be re-added
  e.target.value = '';
});

// ──────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function showStatus(msg, type) {
  const el = document.getElementById('status-area');
  el.innerHTML = `<div class="status-msg ${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 4000);
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────

loadAndRender();
