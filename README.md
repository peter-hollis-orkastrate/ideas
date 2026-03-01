# IFA Tax Assistant — Chrome Extension POC

A proof-of-concept Chrome extension that reads client data from an intelliflo office (iO) page, surfaces HMRC tax planning observations, and generates populated .docx client letters.

## Structure

```
├── mock-io/
│   └── index.html          # Standalone mock intelliflo office page
└── extension/
    ├── manifest.json        # Chrome MV3 manifest
    ├── background.js        # Service worker
    ├── content.js           # Injected into iO pages to extract data
    ├── sidepanel.html/js/css  # Main side panel UI (3 tabs)
    ├── settings.html/js/css   # Template management page
    ├── rules.yaml           # HMRC tax rules — single source of truth
    ├── templates-init.js    # Pre-loads 3 built-in .docx templates
    ├── annual-review.docx   # Built-in template 1
    ├── isa-reminder.docx    # Built-in template 2
    ├── cgt-review.docx      # Built-in template 3
    ├── js-yaml.min.js       # Bundled js-yaml parser
    ├── pizzip.js            # Bundled PizZip (for docx)
    ├── docxtemplater.js     # Bundled Docxtemplater
    └── icons/               # Extension icons (16/48/128px)
```

## How to Run the Demo

1. **Open the mock iO page** — open `mock-io/index.html` in Chrome directly (File → Open, or drag into browser tab)

2. **Load the extension** — go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the `extension/` folder

3. **Open a client record** — the mock iO page is already open from step 1

4. **Open the side panel** — click the IFA Tax Assistant icon in the toolbar

5. **Tab 1 — Client Summary** — click Refresh to extract and display client data

6. **Tab 2 — Tax Observations** — see the 6 colour-coded tax planning observations with full workings

7. **Tab 3 — Generate Letter** — select a template from the dropdown, click Generate, then Download

## Updating Tax Rules

Edit `extension/rules.yaml` — this is the only file that needs updating when HMRC rates change (typically after each Budget/Autumn Statement). No code changes needed.

## Adding Letter Templates

1. Open the side panel → Generate Letter → Manage Templates
2. Click "Add Template" and select a .docx file
3. Use `{placeholder}` syntax in your template — see the placeholder reference in the settings page

## Technical Notes

- Everything runs client-side — no external API calls, no data leaves the browser
- Chrome Manifest V3 with side panel API
- All observations are deterministic (rules engine), not LLM-generated
- Templates stored as base64 in `chrome.storage.local`
