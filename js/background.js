/**
 * Background Service Worker — NetSuite Scripts Manager
 *
 * Handles:
 * 1. Contextual icon activation (enable/disable per tab based on URL)
 * 2. On-demand content script + page script injection
 */

const NETSUITE_URL_PATTERN = /^https:\/\/[^/]*\.netsuite\.com\/app\//;

/* ────────────────────────────────────────────────
 * Cross-browser API reference
 * ──────────────────────────────────────────────── */

const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/* ────────────────────────────────────────────────
 * Contextual Icon Activation
 * ──────────────────────────────────────────────── */

/**
 * Updates the extension icon state based on the tab URL.
 *
 * @param {number} pTabId
 * @param {string} pUrl
 */
const updateIconState = (pTabId, pUrl) => {

    if (!pTabId || !pUrl) {
        return;
    }

    const bIsNetSuitePage = NETSUITE_URL_PATTERN.test(pUrl);

    if (bIsNetSuitePage) {
        browserAPI.action.enable(pTabId);
    } else {
        browserAPI.action.disable(pTabId);
    }
};

/* Disable by default on install */
browserAPI.runtime.onInstalled.addListener(() => {

    browserAPI.action.disable();
});

/* Enable/disable as user navigates */
browserAPI.tabs.onUpdated.addListener((pTabId, pChangeInfo, pTab) => {

    if (pChangeInfo.url || pChangeInfo.status === 'complete') {
        updateIconState(pTabId, pTab.url || '');
    }
});

/* Handle tab activation (switching tabs) */
browserAPI.tabs.onActivated.addListener((pActiveInfo) => {

    /* tabs.get returns a Promise in Firefox MV3, uses callback in Chrome.
     * Using Promise.resolve wrapping handles both cases. */
    Promise.resolve(browserAPI.tabs.get(pActiveInfo.tabId)).then((oTab) => {

        if (oTab) {
            updateIconState(oTab.id, oTab.url || '');
        }

    }).catch(() => {

        /* Tab may have been closed before we got to it */
    });
});

/* ────────────────────────────────────────────────
 * On-Demand Script Injection
 * ──────────────────────────────────────────────── */

/**
 * Listen for messages from popup or content script.
 *
 * @param {Object} pMessage
 * @param {Object} pSender
 * @param {Function} pFnSendResponse
 * @returns {boolean}
 */
browserAPI.runtime.onMessage.addListener((pMessage, pSender, pFnSendResponse) => {

    if (pMessage.type === 'INJECT_AND_GET_DATA') {

        const iTabId = pMessage.tabId;
        const bForceRefresh = !!pMessage.forceRefresh;

        if (!iTabId) {
            pFnSendResponse({error: 'No tab ID provided.'});
            return true;
        }

        /* Inject content.js via chrome.scripting API */
        browserAPI.scripting.executeScript({
            target: {tabId: iTabId},
            files: ['js/content.js']
        }).then(() => {

            if (bForceRefresh) {

                /* Tell content script to clear data and re-inject nsmain.js */
                browserAPI.tabs.sendMessage(iTabId, {type: 'FORCE_REFRESH'}, () => {

                    pFnSendResponse({success: true});
                });
            } else {

                pFnSendResponse({success: true});
            }

        }).catch((oError) => {

            pFnSendResponse({error: oError.message || 'Failed to inject content script.'});
        });

        /* Return true to indicate async response */
        return true;
    }

    if (pMessage.type === 'INJECT_SCHEDULER') {

        const iTabId = pMessage.tabId;

        if (!iTabId) {
            pFnSendResponse({error: 'No tab ID provided.'});
            return true;
        }

        browserAPI.scripting.executeScript({
            target: {tabId: iTabId},
            files: ['js/content.js']
        }).then(() => {

            browserAPI.tabs.sendMessage(iTabId, {
                type: 'SCHEDULER_COMMAND',
                command: pMessage.command,
                deployments: pMessage.deployments
            }, () => {
                pFnSendResponse({success: true});
            });

        }).catch((oError) => {
            pFnSendResponse({error: oError.message || 'Failed to inject content script.'});
        });

        return true;
    }
});
