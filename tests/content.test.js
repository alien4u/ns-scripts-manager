import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://harness.app.netsuite.com';
const sContentSource = readFileSync(new URL('../js/content.js', import.meta.url), 'utf8');

/**
 * Page environment shared by every content.js injection in one tab: the isolated world's window
 * and the DOM. Window properties survive an extension reload, like in Chrome.
 *
 * @returns {Object}
 */
const createPage = () => {

    const oElements = {};
    const aInjected = [];
    const aWindowListeners = [];

    const oWindow = {
        location: {origin: ORIGIN},
        addEventListener: (pType, pListener) => {

            if (pType === 'message') {
                aWindowListeners.push(pListener);
            }
        }
    };

    const oDocument = {
        head: null,
        documentElement: {
            appendChild: (pEl) => {

                oElements[pEl.id] = pEl;

                if (pEl.tagName === 'script') {
                    aInjected.push(pEl.src);
                }
            }
        },
        getElementById: (pId) => oElements[pId] || null,
        createElement: (pTag) => {

            const oEl = {tagName: pTag, id: '', style: {}, dataset: {}, src: ''};
            oEl.remove = () => {

                delete oElements[oEl.id];
            };
            return oEl;
        }
    };

    /**
     * Simulates nsmain.js posting a SCRIPTS_DATA reply in the page (reaches every instance).
     *
     * @param {string} pRequestId
     * @param {Object} pData
     */
    const postFromPage = (pRequestId, pData) => {

        aWindowListeners.forEach((pListener) => pListener({
            source: oWindow,
            origin: ORIGIN,
            data: {type: 'SCRIPTS_DATA', requestId: pRequestId, error: null, data: pData}
        }));
    };

    return {
        window: oWindow,
        document: oDocument,
        elements: oElements,
        injected: aInjected,
        aWindowListeners,
        postFromPage
    };
};

/**
 * One extension instance (runtime). Reloading the extension orphans it: its id becomes undefined.
 *
 * @returns {Object}
 */
const createExtension = () => {

    const aListeners = [];
    const oRuntime = {
        id: 'test-extension-id',
        getURL: (pPath) => `chrome-extension://test/${pPath}`,
        onMessage: {
            addListener: (pListener) => {

                aListeners.push(pListener);
            }
        }
    };

    /**
     * Sends a popup/background message to this runtime's listeners; returns the last response.
     *
     * @param {Object} pMessage
     * @returns {*}
     */
    const send = (pMessage) => {

        let vResponse;
        aListeners.forEach((pListener) => pListener(pMessage, {}, (pResponse) => {

            vResponse = pResponse;
        }));
        return vResponse === undefined ? undefined : JSON.parse(JSON.stringify(vResponse));
    };

    return {chrome: {runtime: oRuntime}, runtime: oRuntime, listeners: aListeners, send};
};

/**
 * Runs the real js/content.js (as chrome.scripting.executeScript does) for an extension in a page.
 *
 * @param {Object} pPage - createPage()
 * @param {Object} pExtension - createExtension()
 */
const inject = (pPage, pExtension) => {

    vm.runInContext(sContentSource, vm.createContext({
        window: pPage.window,
        document: pPage.document,
        chrome: pExtension.chrome
    }));
};

/**
 * Fresh page with one injected extension instance.
 *
 * @returns {{page: Object, ext: Object}}
 */
const loadContentScript = () => {

    const oPage = createPage();
    const oExt = createExtension();
    inject(oPage, oExt);
    return {page: oPage, ext: oExt};
};

describe('content.js request ids', () => {

    test('nsmain is not injected at load; RUN_NSMAIN writes the request element and injects it', () => {

        const {page, ext} = loadContentScript();

        expect(page.injected).toHaveLength(0);

        expect(ext.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: ['3|SALESORDER']}))
            .toEqual({success: true});

        const oDataEl = page.elements.__ns_sm_main_data__;
        expect(oDataEl.dataset.requestId).toBe('req-a');
        expect(JSON.parse(oDataEl.dataset.cacheKeys)).toEqual(['3|SALESORDER']);
        expect(oDataEl.style.display).toBe('none');
        expect(page.injected).toEqual(['chrome-extension://test/js/nsmain.js']);
    });

    test('only the reply to the current request is kept and returned for that request id', () => {

        const {page, ext} = loadContentScript();

        ext.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: []});
        ext.send({type: 'RUN_NSMAIN', requestId: 'req-b', cacheKeys: []});

        /* A stale nsmain run (req-a) answers after req-b started */
        page.postFromPage('req-a', {RECORD_TYPE: 'stale'});
        expect(ext.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-b'})).toBeNull();

        page.postFromPage('req-b', {RECORD_TYPE: 'salesorder'});
        expect(ext.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-b'}).data).toEqual({RECORD_TYPE: 'salesorder'});
        expect(ext.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-a'})).toBeNull();
    });

    test('a new request drops the previous reply (no per-page payload reuse)', () => {

        const {page, ext} = loadContentScript();

        ext.send({type: 'RUN_NSMAIN', requestId: 'req-a', cacheKeys: []});
        page.postFromPage('req-a', {RECORD_TYPE: 'salesorder'});
        ext.send({type: 'RUN_NSMAIN', requestId: 'req-c', cacheKeys: []});

        expect(ext.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-a'})).toBeNull();
        expect(ext.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-c'})).toBeNull();
        expect(page.injected).toHaveLength(2);
    });
});

describe('content.js self-healing guard', () => {

    test('after an extension reload (old runtime id undefined) a new injection registers a working listener', () => {

        const {page, ext: oOld} = loadContentScript();

        /* Extension reloaded: the old instance is orphaned, a new extension instance injects again */
        oOld.runtime.id = undefined;
        const oNew = createExtension();
        inject(page, oNew);

        expect(oNew.listeners).toHaveLength(1);

        oNew.send({type: 'RUN_NSMAIN', requestId: 'req-new', cacheKeys: []});
        page.postFromPage('req-new', {RECORD_TYPE: 'salesorder'});

        expect(oNew.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-new'}).data).toEqual({RECORD_TYPE: 'salesorder'});
    });

    test('a second injection while the first instance is alive does not register again', () => {

        const {page, ext} = loadContentScript();

        inject(page, ext);
        inject(page, ext);

        expect(ext.listeners).toHaveLength(1);
        expect(page.aWindowListeners).toHaveLength(1);
    });

    test('the pre-1.0.6 flag (__NS_SCRIPTS_MANAGER_INJECTED__) does not block injection', () => {

        const oPage = createPage();
        const oExt = createExtension();

        oPage.window.__NS_SCRIPTS_MANAGER_INJECTED__ = true;
        inject(oPage, oExt);

        expect(oExt.listeners).toHaveLength(1);
        expect(oExt.send({type: 'RUN_NSMAIN', requestId: 'req-legacy', cacheKeys: []})).toEqual({success: true});
    });

    test('a leftover pre-1.0.6 instance writing window.__NS_SM_SCRIPT_DATA__ cannot replace the current reply', () => {

        const oPage = createPage();

        /* v1.0.5 content.js still listening in a never-reloaded tab: stores every reply on window, no checks */
        oPage.window.addEventListener('message', (pEvent) => {

            if (pEvent.data.type === 'SCRIPTS_DATA') {
                oPage.window.__NS_SM_SCRIPT_DATA__ = pEvent.data;
            }
        });

        const oExt = createExtension();
        inject(oPage, oExt);

        oExt.send({type: 'RUN_NSMAIN', requestId: 'req-current', cacheKeys: []});
        oPage.postFromPage('req-current', {RECORD_TYPE: 'salesorder'});

        /* A late reply from an older nsmain run arrives after the current one */
        oPage.postFromPage('req-older', {RECORD_TYPE: 'stale'});

        expect(oPage.window.__NS_SM_SCRIPT_DATA__.requestId).toBe('req-older');
        expect(oExt.send({type: 'GET_SCRIPTS_DATA', requestId: 'req-current'}).data)
            .toEqual({RECORD_TYPE: 'salesorder'});
    });

    test('a probe that throws (invalidated context) counts as gone', () => {

        const oPage = createPage();
        const oExt = createExtension();

        oPage.window.__NS_SM_CONTENT_ALIVE__ = () => {

            throw new Error('can\'t access dead object');
        };
        inject(oPage, oExt);

        expect(oExt.listeners).toHaveLength(1);
    });
});
