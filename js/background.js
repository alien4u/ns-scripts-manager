/**
 * Background Service Worker — NetSuite Scripts Manager
 *
 * Handles on-demand content script + page script injection.
 */

const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

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

        const nTabId = pMessage.tabId;

        if (!nTabId) {
            pFnSendResponse({error: 'No tab ID provided.'});
            return true;
        }

        browserAPI.scripting.executeScript({
            target: {tabId: nTabId},
            files: ['js/content.js']
        }).then(() => {

            /* Every popup request runs nsmain.js fresh; cache keys let it skip the searches */
            browserAPI.tabs.sendMessage(nTabId, {
                type: 'RUN_NSMAIN',
                requestId: pMessage.requestId || '',
                cacheKeys: Array.isArray(pMessage.cacheKeys) ? pMessage.cacheKeys : []
            }, () => {
                const _ignored = browserAPI.runtime.lastError;
                pFnSendResponse({success: true});
            });

        }).catch((oError) => {

            pFnSendResponse({error: oError.message || 'Failed to inject content script.'});
        });

        /* Return true to indicate async response */
        return true;
    }

    if (pMessage.type === 'INJECT_SCHEDULER') {

        const nTabId = pMessage.tabId;

        if (!nTabId) {
            pFnSendResponse({error: 'No tab ID provided.'});
            return true;
        }

        browserAPI.scripting.executeScript({
            target: {tabId: nTabId},
            files: ['js/content.js']
        }).then(() => {

            browserAPI.tabs.sendMessage(nTabId, {
                type: 'SCHEDULER_COMMAND',
                command: pMessage.command,
                deployments: pMessage.deployments
            }, () => {
                const _ignored = browserAPI.runtime.lastError;
                pFnSendResponse({success: true});
            });

        }).catch((oError) => {
            pFnSendResponse({error: oError.message || 'Failed to inject content script.'});
        });

        return true;
    }
});
