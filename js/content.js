/**
 * Content Script (runs in ISOLATED world)
 *
 * Responsibilities:
 * 1. Inject nsmain.js into the page's MAIN world for data query
 * 2. Listen for data messages from nsmain.js (via window.postMessage)
 * 3. Respond to popup requests (GET_SCRIPTS_DATA, FORCE_REFRESH)
 */

(() => {

    /* Guard: prevent multiple injections per page */
    if (window.__NS_SCRIPTS_MANAGER_INJECTED__) {
        return;
    }

    window.__NS_SCRIPTS_MANAGER_INJECTED__ = true;

    const oBrowserRuntime = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;

    /* ────────────────────────────────────────────────
     * Forward messages from page (nsmain.js) to storage
     * ──────────────────────────────────────────────── */

    /**
     * Listener for window messages
     *
     * @param {MessageEvent} pEvent
     */
    window.addEventListener('message', (pEvent) => {

        if (pEvent.source !== window || pEvent.origin !== window.location.origin || !pEvent.data?.type) {
            return;
        }

        if (pEvent.data.type === 'SCRIPTS_DATA') {
            window.__NS_SM_SCRIPT_DATA__ = pEvent.data;
        }

        if (pEvent.data.type === 'SCHEDULER_COLLECT_RESULT' || pEvent.data.type === 'SCHEDULER_CHECK_RESULT' || pEvent.data.type === 'SCHEDULER_APPLY_RESULT') {
            window.__NS_SCHEDULER_RESULT__ = pEvent.data;
        }

        if (pEvent.data.type === 'SCHEDULER_APPLY_PROGRESS') {

            if (!window.__NS_SCHEDULER_PROGRESS__) {
                window.__NS_SCHEDULER_PROGRESS__ = [];
            }

            window.__NS_SCHEDULER_PROGRESS__.push(pEvent.data.data);
        }
    });

    /* ────────────────────────────────────────────────
     * Inject nsmain.js into the page's MAIN world
     * ──────────────────────────────────────────────── */

    /**
     * Injects the main script into the page context.
     */
    const injectNSMain = () => {

        const sNSId = 'ns-scripts-manager-nsmain';
        const oExisting = document.getElementById(sNSId);

        if (oExisting) {
            oExisting.remove();
        }

        const oScript = document.createElement('script');
        oScript.id = sNSId;
        oScript.src = oBrowserRuntime.getURL('js/nsmain.js');

        /* Clean up the <script> tag after it loads */
        oScript.onload = () => {
            oScript.remove();
        };

        oScript.onerror = () => {
            oScript.remove();
        };

        (document.head || document.documentElement).appendChild(oScript);
    };

    injectNSMain();

    /* ────────────────────────────────────────────────
     * Inject nsscheduler.js with a command + optional data
     * ──────────────────────────────────────────────── */

    const injectScheduler = (pCommand, pDeployments) => {

        /* Pass command + data via a hidden DOM element (both worlds can read DOM) */
        const oDataEl = document.createElement('div');
        oDataEl.id = '__ns_scheduler_data__';
        oDataEl.style.display = 'none';
        oDataEl.dataset.command = pCommand;

        if (pDeployments) {
            oDataEl.dataset.deployments = JSON.stringify(pDeployments);
        }

        document.documentElement.appendChild(oDataEl);

        const sSchedulerId = 'ns-scripts-manager-nsscheduler';
        const oExisting = document.getElementById(sSchedulerId);

        if (oExisting) {
            oExisting.remove();
        }

        const oScript = document.createElement('script');
        oScript.id = sSchedulerId;
        oScript.src = oBrowserRuntime.getURL('js/nsscheduler.js');
        oScript.onload = () => oScript.remove();
        oScript.onerror = () => oScript.remove();

        (document.head || document.documentElement).appendChild(oScript);
    };

    /* ────────────────────────────────────────────────
     * Handle messages from the popup
     * ──────────────────────────────────────────────── */

    const oRuntimeOnMessage = (typeof browser !== 'undefined' && browser.runtime)
        ? browser.runtime.onMessage
        : chrome.runtime.onMessage;

    /**
     * Message listener for popup communication.
     *
     * @param {Object} pMsg
     * @param {Object} pSender
     * @param {Function} pSendResponse
     */
    oRuntimeOnMessage.addListener((pMsg, pSender, pSendResponse) => {

        if (pMsg.type === 'GET_SCRIPTS_DATA') {
            pSendResponse(window.__NS_SM_SCRIPT_DATA__ || null);
        }

        if (pMsg.type === 'FORCE_REFRESH') {

            /* Clear stored data and re-inject nsmain.js */
            window.__NS_SM_SCRIPT_DATA__ = null;
            injectNSMain();
            pSendResponse({success: true});
        }

        if (pMsg.type === 'SCHEDULER_COMMAND') {

            window.__NS_SCHEDULER_RESULT__ = null;
            window.__NS_SCHEDULER_PROGRESS__ = [];
            injectScheduler(pMsg.command, pMsg.deployments);
            pSendResponse({success: true});
        }

        if (pMsg.type === 'GET_SCHEDULER_PROGRESS') {
            pSendResponse(window.__NS_SCHEDULER_PROGRESS__ || []);
        }

        if (pMsg.type === 'GET_SCHEDULER_RESULT') {

            const oResult = window.__NS_SCHEDULER_RESULT__;

            if (oResult && pMsg.expectedType && oResult.type !== pMsg.expectedType) {
                pSendResponse(null);
            } else {
                pSendResponse(oResult || null);
            }
        }
    });

})();
