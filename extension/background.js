// background.js — Service Worker for IFA Tax Assistant
// Handles side panel opening and message routing between content script and side panel

// Load built-in templates on first install
importScripts('templates-init.js');

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When side panel requests data from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SIDEPANEL_REQUEST_DATA') {
    // Get the active tab and inject/message the content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ error: 'No active tab' });
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DATA' }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script may not be injected yet — try scripting API
          chrome.scripting.executeScript(
            { target: { tabId }, files: ['content.js'] },
            () => {
              if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
                return;
              }
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DATA' }, (resp) => {
                  sendResponse(resp || { error: 'No data returned' });
                });
              }, 300);
            }
          );
        } else {
          sendResponse(response || { error: 'No data returned' });
        }
      });
    });
    return true; // keep message channel open for async response
  }

  // Forward extracted data from content script to side panel
  if (message.type === 'CLIENT_DATA') {
    // Broadcast to all extension pages (side panel listens for this)
    chrome.runtime.sendMessage({ type: 'CLIENT_DATA_UPDATE', data: message.data });
  }
});

// Set side panel options when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Pre-load example templates on first install
  chrome.storage.local.get(['templates_initialised'], (result) => {
    if (!result.templates_initialised) {
      chrome.storage.local.set({
        templates_initialised: true,
        templates: [] // Templates are created by generate-templates.js and stored separately
      });
    }
  });
});
