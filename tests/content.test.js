import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://harness.app.netsuite.com';
const sContentSource = readFileSync(new URL('../js/content.js', import.meta.url), 'utf8');

/**
 * Loads the real js/content.js once with a fake isolated-world window, DOM and runtime.
 *
 * @returns {Object} Handles to drive the content script
 */
const loadContentScript = () => {

    const oElements = {};
    const aInjected = [];
    let fnWindowListener = null;
    let fnRuntimeListener = null;

    const oWindow = {
        location: {origin: ORIGIN},
        addEventListener: (pType, pListener) => {

            if (pType === 'message') {
                fnWindowListener = pListener;
            }
        }
    };

    const oDocumentElement = {
        appendChild: (pEl) => {

            oElements[pEl.id] = pEl;

            if (pEl.tagName === 'script') {
                aInjected.push(pEl.src);
            }
        }
    };

    const oDocument = {
        head: null,
        documentElement: oDocumentElement,
        getElementById: (pId) => oElements[pId] || null,
        createElement: (pTag) => {

            const oEl = {tagName: pTag, id: '', style: {}, dataset: {}, src: ''};
            oEl.remove = () => {

                delete oElements[oEl.id];
            };
            return oEl;
        }
    };

    const oChrome = {
        runtime: {
            getURL: (pPath) => `chrome-extension://test/${pPath}`,
            onMessage: {
                addListener: (pListener) => {

                    fnRuntimeListener = pListener;
                }
            }
        }
    };

    vm.runInContext(sContentSource, vm.createContext({window: oWindow, document: oDocument, chrome: oChrome}));

    /**
     * Sends a popup/background message and returns the synchronous response.
     *
     * @param {Object} pMessage
     * @returns {*}
     */
    const send = (pMessage) => {

        let vResponse;
        fnRuntimeListener(pMessage, {}, (pResponse) => {

            vResponse = pResponse;
        });
        return vResponse === undefined ? undefined : JSON.parse(JSON.stringify(vResponse));
    };

    /**
     * Simulates nsmain.js posting a SCRIPTS_DATA reply in the page.
     *
     * @param {string} pRequestId
     * @param {Object} pData
     */
    const postFromPage = (pRequestId, pData) => {

        fnWindowListener({
            source: oWindow,
            origin: ORIGIN,
            data: {type: 'SCRIPTS_DATA', requestId: pRequestId, error: null, data: pData}
        });
    };

    return {send, postFromPage, elements: oElements, injected: aInjected};
};

describe('content.js request ids', () => {

    test('nsmain is not injected at load; RUN_NSMAIN writes the request element and injects it', () => {

        const oContent = loadContentScript();

        expect(oContent.injected).toHaveLength(0);

        expect(oContent.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: ['3|SALESORDER']}))
            .toEqual({success: true});

        const oDataEl = oContent.elements.__ns_sm_main_data__;
        expect(oDataEl.dataset.requestId).toBe('req-a');
        expect(JSON.parse(oDataEl.dataset.cacheKeys)).toEqual(['3|SALESORDER']);
        expect(oDataEl.style.display).toBe('none');
        expect(oContent.injected).toEqual(['chrome-extension://test/js/nsmain.js']);
    });

    test('only the reply to the current request is kept and returned for that request id', () => {

        const oContent = loadContentScript();

        oContent.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: []});
        oContent.send({type: 'RUN_NSMAIN', requestId: 'req-b', cacheKeys: []});

        /* A stale nsmain run (req-a) answers after req-b started */
        oContent.postFromPage('req-a', {RECORD_TYPE: 'stale'});
        expect(oContent.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-b'})).toBeNull();

        oContent.postFromPage('req-b', {RECORD_TYPE: 'salesorder'});
        expect(oContent.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-b'}).data).toEqual({RECORD_TYPE: 'salesorder'});
        expect(oContent.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-a'})).toBeNull();
    });

    test('a new request drops the previous reply (no per-page payload reuse)', () => {

        const oContent = loadContentScript();

        oContent.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: []});
        oContent.postFromPage('req-a', {RECORD_TYPE: 'salesorder'});
        oContent.send({type: 'RUN_NSMAIN', requestId: 'req-c', cacheKeys: []});

        expect(oContent.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-a'})).toBeNull();
        expect(oContent.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-c'})).toBeNull();
        expect(oContent.injected).toHaveLength(2);
    });
});
