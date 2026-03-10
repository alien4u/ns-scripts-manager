/**
 * Background Service Worker — NetSuite Scripts Manager
 *
 * Handles:
 * 1. Contextual icon activation (enable/disable per tab based on URL)
 * 2. On-demand content script + page script injection
 */

const NETSUITE_URL_PATTERN = /^https:\/\/[^/]*\.netsuite\.com\/app\//;

const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/* ────────────────────────────────────────────────
 * Contextual Icon Activation
 * ──────────────────────────────────────────────── */

if (chrome.declarativeContent) {

    /* Chrome: use declarativeContent (no host_permissions needed) */
    browserAPI.runtime.onInstalled.addListener(() => {

        browserAPI.action.disable();

        chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {

            chrome.declarativeContent.onPageChanged.addRules([{
                conditions: [
                    new chrome.declarativeContent.PageStateMatcher({
                        pageUrl: {hostSuffix: '.netsuite.com', pathPrefix: '/app/'}
                    })
                ],
                actions: [new chrome.declarativeContent.ShowAction()]
            }]);
        });
    });

} else {

    /* Firefox: fall back to tabs-based URL matching */
    const updateIconState = (pTabId, pUrl) => {

        if (!pTabId) return;

        if (pUrl && NETSUITE_URL_PATTERN.test(pUrl)) {
            browserAPI.action.enable(pTabId);
        } else {
            browserAPI.action.disable(pTabId);
        }
    };

    browserAPI.runtime.onInstalled.addListener(() => {
        browserAPI.action.disable();
    });

    browserAPI.tabs.onUpdated.addListener((pTabId, pChangeInfo, pTab) => {

        if (pChangeInfo.url || pChangeInfo.status === 'complete') {
            updateIconState(pTabId, pTab.url || '');
        }
    });

    browserAPI.tabs.onActivated.addListener((pActiveInfo) => {

        Promise.resolve(browserAPI.tabs.get(pActiveInfo.tabId)).then((oTab) => {
            if (oTab) updateIconState(oTab.id, oTab.url || '');
        }).catch(() => {});
    });
}

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
        const bForceRefresh = !!pMessage.forceRefresh;

        if (!nTabId) {
            pFnSendResponse({error: 'No tab ID provided.'});
            return true;
        }

        browserAPI.scripting.executeScript({
            target: {tabId: nTabId},
            files: ['js/content.js']
        }).then(() => {

            if (bForceRefresh) {

                browserAPI.tabs.sendMessage(nTabId, {type: 'FORCE_REFRESH'}, () => {
                    const _ignored = browserAPI.runtime.lastError;
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
