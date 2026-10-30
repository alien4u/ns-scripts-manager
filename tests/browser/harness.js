/**
 * Popup harness -- renders the real popup.html body, css/main.css and js/popup.js against a
 * fake `chrome` API and stubbed scriptedrecord.nl responses, then asserts the DOM.
 *
 * Query params:
 *   ?scenario=record | unknown-form | forms-only | create-mode | no-record | no-api | deployed-filter | slow-forms
 *             | count-warnings | cache | no-session | slow-reply | non-netsuite | refresh-during-read
 *   ?fixture=<url>   fixture JSON, same shape as tests/browser/fixtures/record.json (default)
 *
 * Expected badges come from the PLAN STATE table encoded below, not from popup.js.
 * Results are printed into the page and exposed as
 *   window.__HARNESS__ = {done, scenario, fixture, passed, failed, results: [{name, pass, detail}]}
 *
 * Test-only file: build.sh packages manifest, popup.html, css, img and js only.
 */

(() => {

    const SCENARIOS = [
        'record', 'unknown-form', 'forms-only', 'create-mode', 'no-record', 'no-api', 'deployed-filter', 'slow-forms',
        'count-warnings', 'cache', 'no-session', 'slow-reply', 'non-netsuite', 'refresh-during-read'
    ];
    const NO_RECORD_TEXT = 'Open a NetSuite record to view its scripts.';
    const FORM_TITLE = 'Runs only on records that use this form';
    const DEFAULT_GROUP_ORDER = ['Client', 'Form Scripts', 'User Event', 'Workflows', 'Workflow Action', 'Mass Update'];
    const LEGACY_GROUP_ORDER = [
        'User Event', 'Client', 'Mass Update', 'Workflow Action', 'Custom GL Lines (Plug-in)', 'Workflows'
    ];
    const RUN_STATES = ['active', 'testing', 'current_form', 'unknown_form'];
    const MIN_CONTRAST = 4.5;
    const CACHE_TTL_MS = 2 * 60 * 1000;
    const NON_NETSUITE_URL = 'https://www.example.com/';
    const NON_NETSUITE_TEXT = 'Navigate to a NetSuite page to use this extension.';
    const BRAND_ORIGIN = 'https://www.alientechnologyllc.com';

    const oParams = new URLSearchParams(window.location.search);
    const sScenario = oParams.get('scenario') || 'record';
    const sFixtureUrl = oParams.get('fixture') || 'tests/browser/fixtures/record.json';

    const oHarness = {done: false, scenario: sScenario, fixture: sFixtureUrl, passed: 0, failed: 0, results: []};
    window.__HARNESS__ = oHarness;

    const fnNativeFetch = window.fetch.bind(window);
    const aPageErrors = [];
    const aCspViolations = [];
    const oLog = {
        fetches: [], aborted: [], maxInFlight: 0, runtimeMessages: [], storageSets: [], tabsCreated: [],
        injects: [], replies: [], staleServed: 0, polls: 0, injectAt: 0, firstReplyAt: 0
    };
    const oStore = {};
    const oSession = {};
    const oClock = {now: Date.parse('2026-10-30T12:00:00Z')};
    const oState = {
        response: null,
        reply: null,
        tabUrl: '',
        popupHtml: '',
        formsHtmlByType: {},
        stallForms: false,
        deferSchedulerGet: false,
        releaseSchedulerGet: null,
        staleReplies: [],
        forceLightOnce: false,
        advanceClockOnReply: 0,
        deferSessionSet: false,
        deferSessionGet: false,
        releaseSessionGet: null,
        replyDelayMs: 0,
        releaseSessionSet: null
    };

    window.addEventListener('error', (pEvent) => {

        aPageErrors.push(pEvent.message);
    });

    window.addEventListener('unhandledrejection', (pEvent) => {

        aPageErrors.push(String(pEvent.reason));
    });

    /* Registered before popup.js loads; serve.js sends script-src 'self' like the extension */
    document.addEventListener('securitypolicyviolation', (pEvent) => {

        aCspViolations.push(`${pEvent.effectiveDirective}: ${pEvent.sample || pEvent.blockedURI}`);
    }, true);

    /* ────────────────────────────────────────────────
     * Assertion helpers
     * ──────────────────────────────────────────────── */

    /**
     * Records one assertion.
     *
     * @param {string} pName
     * @param {boolean} pPass
     * @param {string} [pDetail] - Shown on failure
     */
    const check = (pName, pPass, pDetail) => {

        oHarness.results.push({name: pName, pass: !!pPass, detail: pPass ? '' : (pDetail || '')});

        if (pPass) {
            oHarness.passed++;
        } else {
            oHarness.failed++;
        }
    };

    /**
     * Records a strict-equality assertion (arrays/objects compared as JSON).
     *
     * @param {string} pName
     * @param {*} pActual
     * @param {*} pExpected
     */
    const checkEqual = (pName, pActual, pExpected) => {

        const sActual = JSON.stringify(pActual);
        const sExpected = JSON.stringify(pExpected);
        check(pName, sActual === sExpected, `expected ${sExpected}, got ${sActual}`);
    };

    /**
     * Resolves after pMs milliseconds.
     *
     * @param {number} pMs
     * @returns {Promise<void>}
     */
    const delay = (pMs) => new Promise((pResolve) => setTimeout(pResolve, pMs));

    /**
     * Polls until pCondition() is truthy.
     *
     * @param {Function} pCondition
     * @param {number} pTimeoutMs
     * @param {string} pLabel
     */
    const waitFor = async (pCondition, pTimeoutMs, pLabel) => {

        const nStart = performance.now();

        while (!pCondition()) {

            if (performance.now() - nStart > pTimeoutMs) {
                throw new Error('Timed out waiting for ' + pLabel);
            }

            await delay(50);
        }
    };

    /**
     * True once popup.js rendered cards or a message.
     *
     * @returns {boolean}
     */
    const isRendered = () => {

        return !!document.querySelector('#scriptCards .section-header') ||
            document.getElementById('message').classList.contains('visible');
    };

    /* ────────────────────────────────────────────────
     * Oracle: PLAN STATE table
     * ──────────────────────────────────────────────── */

    /**
     * Expected badge, tooltip, dimming and dot for a STATE.
     *
     * @param {string} pState
     * @param {string} pStatus
     * @param {string} pKind - 'script' | 'workflow' | 'form'
     * @returns {{text: string, look: string, title: string, dimmed: boolean, dot: string}}
     */
    const expectedBadge = (pState, pStatus, pKind) => {

        const sStatus = pStatus || '';

        switch (pState) {

            case 'active':
                return {text: sStatus.toLowerCase(), look: 'active', title: '', dimmed: false, dot: 'green'};

            case 'testing':
                return {
                    text: 'testing',
                    look: 'testing',
                    title: pKind === 'workflow'
                        ? 'Testing: initiates only for the workflow owner'
                        : 'Testing: runs only for the script owner',
                    dimmed: false,
                    dot: 'amber'
                };

            case 'undeployed':
                return {
                    text: 'undeployed', look: 'inactive', dimmed: true, dot: 'none',
                    title: 'The deployment\'s Deployed checkbox is unchecked'
                };

            case 'script_inactive':
                return {
                    text: 'script inactive', look: 'inactive', dimmed: true, dot: 'none',
                    title: 'The script record is marked Inactive'
                };

            case 'inactive':
                return {
                    text: 'inactive', look: 'inactive', dimmed: true, dot: 'none',
                    title: 'The workflow is marked Inactive'
                };

            case 'current_form':
                return {text: 'current form', look: 'active', title: '', dimmed: false, dot: 'green'};

            case 'other_form':
                return {text: 'other form', look: 'inactive', title: FORM_TITLE, dimmed: true, dot: 'none'};

            case 'unknown_form':
                return {text: 'form script', look: 'neutral', title: FORM_TITLE, dimmed: false, dot: 'none'};

            default:
                return {
                    text: sStatus.toLowerCase() || 'n/a', look: 'inactive', dimmed: true, dot: 'none',
                    title: 'Status: ' + (sStatus || 'n/a')
                };
        }
    };

    /**
     * Expected form-script state for a row's form id.
     *
     * @param {string} pFormId - '' when the Form link does not resolve
     * @param {string} pCustomFormId - '' when unknown
     * @returns {string}
     */
    const expectedFormState = (pFormId, pCustomFormId) => {

        if (!pCustomFormId || !pFormId) {
            return 'unknown_form';
        }

        return pFormId === pCustomFormId ? 'current_form' : 'other_form';
    };

    /* ────────────────────────────────────────────────
     * DOM readers
     * ──────────────────────────────────────────────── */

    /**
     * Rendered sections in order.
     *
     * @returns {Array<{title: string, count: string, body: HTMLElement}>}
     */
    const getSections = () => {

        return [...document.querySelectorAll('#scriptCards .section-header')].map((pHeader) => ({
            title: pHeader.querySelector('.section-header-text').textContent,
            count: pHeader.querySelector('.section-header-count').textContent,
            header: pHeader,
            body: pHeader.nextElementSibling
        }));
    };

    /**
     * Cards of the section with the given header text.
     *
     * @param {string} pTitle
     * @returns {HTMLElement[]}
     */
    const getSectionCards = (pTitle) => {

        const oSection = getSections().find((pSection) => pSection.title === pTitle);
        return oSection ? [...oSection.body.querySelectorAll('.script-card')] : [];
    };

    /**
     * Deployment internal id from a deployment record URL (`id` param), '' when absent.
     *
     * @param {string} pUrl
     * @returns {string}
     */
    const deploymentKey = (pUrl) => {

        try {
            return new URL(pUrl).searchParams.get('id') || '';
        } catch (pErr) {
            return '';
        }
    };

    /**
     * Finds a script card by deployment internal id. Script ids such as customdeploy1 repeat
     * across scripts in real accounts, so the card's deployment link is matched instead.
     *
     * @param {string} pDeploymentUrl - DEPLOYMENT_URL from the payload
     * @returns {HTMLElement|undefined}
     */
    const findScriptCard = (pDeploymentUrl) => {

        const sKey = deploymentKey(pDeploymentUrl);

        return [...document.querySelectorAll('#scriptCards .script-card')].find((pCard) => {

            const oLink = pCard.querySelector('.sm-deploy-id');
            return !!sKey && !!oLink && deploymentKey(oLink.href) === sKey;
        });
    };

    /**
     * Finds a card by its name in a section.
     *
     * @param {string} pSectionTitle
     * @param {string} pName
     * @returns {HTMLElement|undefined}
     */
    const findNamedCard = (pSectionTitle, pName) => {

        return getSectionCards(pSectionTitle).find((pCard) =>
            pCard.querySelector('.card-name').textContent.trim() === pName
        );
    };

    /**
     * Serializes everything the cards area shows (headers, badges, tooltips, links, hooks) so two
     * renders can be compared.
     *
     * @returns {string}
     */
    const snapshotView = () => {

        return JSON.stringify(getSections().map((pSection) => ({
            header: pSection.header.textContent,
            cards: [...pSection.body.querySelectorAll('.script-card')].map((pCard) => ({
                name: pCard.querySelector('.card-name').textContent.trim(),
                meta: pCard.querySelector('.card-meta').textContent,
                badge: readBadge(pCard),
                links: [...pCard.querySelectorAll('a[href]')].map((pLink) => pLink.href),
                hooks: [...pCard.querySelectorAll('.sm-hook-tag')].map((pTag) => pTag.textContent)
            }))
        })));
    };

    /**
     * Reads badge, tooltip, dimming and dot of a card.
     *
     * @param {HTMLElement} pCard
     * @returns {Object}
     */
    const readBadge = (pCard) => {

        const aBadges = pCard.querySelectorAll('.sm-badge');
        const oBadge = aBadges[0];
        const oDot = pCard.querySelector('.sm-deployed-dot');
        const aLooks = ['active', 'testing', 'inactive', 'neutral'];
        let sDot = 'none';

        if (oDot) {
            sDot = oDot.classList.contains('testing') ? 'amber' : 'green';
        }

        return {
            badges: aBadges.length,
            text: oBadge ? oBadge.textContent : '',
            look: oBadge ? aLooks.filter((pLook) => oBadge.classList.contains(pLook)).join(' ') : '',
            title: oBadge ? (oBadge.getAttribute('title') || '') : '',
            dimmed: pCard.classList.contains('inactive'),
            dot: sDot
        };
    };

    /**
     * Asserts one card against the STATE table.
     *
     * @param {string} pLabel
     * @param {HTMLElement} pCard
     * @param {Object} pExpected - expectedBadge() result
     */
    const checkBadge = (pLabel, pCard, pExpected) => {

        const oActual = readBadge(pCard);
        const aDiffs = [];

        if (oActual.badges !== 1) {
            aDiffs.push(`badges=${oActual.badges} (want 1)`);
        }

        ['text', 'look', 'title', 'dimmed', 'dot'].forEach((pKey) => {

            if (oActual[pKey] !== pExpected[pKey]) {
                aDiffs.push(`${pKey}=${JSON.stringify(oActual[pKey])} (want ${JSON.stringify(pExpected[pKey])})`);
            }
        });

        const sDimmed = pExpected.dimmed ? 'dimmed' : 'not dimmed';

        check(
            `${pLabel}: badge "${pExpected.text}", tooltip, ${sDimmed}, dot ${pExpected.dot}`,
            aDiffs.length === 0,
            aDiffs.join('; ')
        );
    };

    /* ────────────────────────────────────────────────
     * Color contrast (WCAG relative luminance)
     * ──────────────────────────────────────────────── */

    /**
     * Contrast ratio between two computed CSS colors.
     *
     * @param {string} pColorA - e.g. 'rgb(133, 100, 4)'
     * @param {string} pColorB
     * @returns {number}
     */
    const contrastRatio = (pColorA, pColorB) => {

        const aLuminance = [pColorA, pColorB].map((pColor) => {

            const [nR, nG, nB] = pColor.match(/[\d.]+/g).slice(0, 3).map((pPart) => {

                /* sRGB channel to linear light */
                const nChannel = Number(pPart) / 255;
                return nChannel <= 0.03928 ? nChannel / 12.92 : ((nChannel + 0.055) / 1.055) ** 2.4;
            });

            return 0.2126 * nR + 0.7152 * nG + 0.0722 * nB;
        }).sort((pA, pB) => pB - pA);

        return (aLuminance[0] + 0.05) / (aLuminance[1] + 0.05);
    };

    /* ────────────────────────────────────────────────
     * Fakes
     * ──────────────────────────────────────────────── */

    /**
     * Reply the fake content script / nsmain pair gives to one popup request: light payload when
     * the request carries a fresh key for this role and record type (the nsmain.js rule, unit
     * tested there), full payload otherwise. oState.forceLightOnce simulates a key mismatch.
     *
     * @param {string} pRequestId
     * @param {string[]} pCacheKeys
     * @returns {Object}
     */
    const buildReply = (pRequestId, pCacheKeys) => {

        if (oState.response.error) {
            return {...structuredClone(oState.response), requestId: pRequestId};
        }

        const oData = oState.response.data;
        const sKey = `${oData.ROLE_ID || ''}|${String(oData.RECORD_TYPE).toUpperCase()}`;
        const bLight = oState.forceLightOnce || (!!oData.ROLE_ID && pCacheKeys.includes(sKey));

        oState.forceLightOnce = false;
        oLog.replies.push(bLight ? 'light' : 'full');

        return {
            type: 'SCRIPTS_DATA',
            requestId: pRequestId,
            error: null,
            data: bLight
                ? {
                    FROM_CACHE: true,
                    RECORD_TYPE: oData.RECORD_TYPE,
                    ROLE_ID: oData.ROLE_ID,
                    CUSTOM_FORM_ID: oData.CUSTOM_FORM_ID,
                    CLIENT_LIMIT_REMOVED: oData.CLIENT_LIMIT_REMOVED,
                    API_VERSION: oData.API_VERSION
                }
                : structuredClone(oData)
        };
    };

    /**
     * Promise-based fake of a chrome.storage area backed by a plain object.
     *
     * @param {Object} pBacking
     * @param {Array} [pSetLog]
     * @returns {Object}
     */
    const createStorageArea = (pBacking, pSetLog) => {

        return {
            get: async (pKeys) => {

                const aKeys = pKeys == null ? Object.keys(pBacking) : [].concat(pKeys);

                /* Held read (session area): released by the harness with oState.releaseSessionGet() */
                if (pBacking === oSession && oState.deferSessionGet) {
                    oState.deferSessionGet = false;
                    await new Promise((pResolve) => {

                        oState.releaseSessionGet = pResolve;
                    });
                }

                return Object.fromEntries(
                    aKeys.filter((pKey) => pKey in pBacking).map((pKey) => [pKey, structuredClone(pBacking[pKey])])
                );
            },
            set: async (pItems) => {

                /* Held write (session area): released by the harness with oState.releaseSessionSet() */
                if (pBacking === oSession && oState.deferSessionSet) {
                    oState.deferSessionSet = false;
                    await new Promise((pResolve) => {

                        oState.releaseSessionSet = pResolve;
                    });
                }

                pSetLog?.push(structuredClone(pItems));
                Object.assign(pBacking, structuredClone(pItems));
            },
            remove: async (pKeys) => {

                [].concat(pKeys).forEach((pKey) => {

                    delete pBacking[pKey];
                });
            }
        };
    };

    /**
     * Installs the fake extension API used by popup.js.
     *
     * @param {Object} pManifest
     * @param {boolean} pWithSession - false: no chrome.storage.session (older browsers)
     */
    const installChrome = (pManifest, pWithSession) => {

        const oFakeChrome = {
            runtime: {
                lastError: undefined,
                getManifest: () => pManifest,
                sendMessage: async (pMessage) => {

                    oLog.runtimeMessages.push(pMessage.type);

                    if (pMessage.type === 'INJECT_AND_GET_DATA') {
                        oLog.injects.push({requestId: pMessage.requestId, cacheKeys: [...(pMessage.cacheKeys || [])]});
                        oLog.injectAt = performance.now();
                        oState.reply = buildReply(pMessage.requestId, pMessage.cacheKeys || []);
                    }

                    return {success: true};
                }
            },
            storage: {
                local: {
                    get: async (pKeys) => {

                        const aKeys = pKeys == null ? Object.keys(oStore) : [].concat(pKeys);

                        /* Deferred read: held until the harness calls oState.releaseSchedulerGet() */
                        if (oState.deferSchedulerGet && aKeys.includes('scheduledDeployments')) {
                            oState.deferSchedulerGet = false;
                            await new Promise((pResolve) => {

                                oState.releaseSchedulerGet = pResolve;
                            });
                        }

                        return Object.fromEntries(
                            aKeys.filter((pKey) => pKey in oStore).map((pKey) => [pKey, structuredClone(oStore[pKey])])
                        );
                    },
                    set: async (pItems) => {

                        oLog.storageSets.push(structuredClone(pItems));
                        Object.assign(oStore, structuredClone(pItems));
                    },
                    remove: async (pKeys) => {

                        [].concat(pKeys).forEach((pKey) => {

                            delete oStore[pKey];
                        });
                    }
                },
                ...(pWithSession ? {session: createStorageArea(oSession)} : {})
            },
            tabs: {
                query: async () => [{id: 1, url: oState.tabUrl}],
                sendMessage: (pTabId, pMessage, pCallback) => {

                    let oReply = null;

                    if (pMessage.type === 'GET_SCRIPTS_DATA') {

                        oLog.polls++;

                        if (oState.replyDelayMs && performance.now() - oLog.injectAt < oState.replyDelayMs) {

                            /* slow-reply: nsmain has not answered yet (content.js returns null) */
                            oReply = null;
                        } else if (oState.staleReplies.length > 0) {
                            oReply = oState.staleReplies.shift();
                            oLog.staleServed++;
                        } else {
                            oReply = structuredClone(oState.reply);
                            oLog.firstReplyAt = oLog.firstReplyAt || performance.now();
                        }

                        /* Entry expires between sending the keys and receiving the reply */
                        oClock.now += oState.advanceClockOnReply;
                        oState.advanceClockOnReply = 0;
                    }

                    setTimeout(() => {

                        if (pCallback) {
                            pCallback(oReply);
                        }
                    }, 0);
                },
                create: async (pOptions) => {

                    oLog.tabsCreated.push(pOptions.url);
                    return {};
                }
            }
        };

        try {
            Object.defineProperty(window, 'chrome', {value: oFakeChrome, configurable: true, writable: true});
        } catch (pErr) {
            window.chrome = oFakeChrome;
        }

        if (window.chrome !== oFakeChrome) {
            throw new Error('Could not install the fake chrome API');
        }
    };

    /**
     * Routes scriptedrecord.nl requests (stack order page and forms fragment) to fixture HTML.
     *
     * @param {string} pFormsHtml
     * @param {string} pStackHtml
     */
    const installFetch = (pFormsHtml, pStackHtml) => {

        let nInFlight = 0;

        window.fetch = async (pInput, pInit) => {

            const sUrl = typeof pInput === 'string' ? pInput : String(pInput.url || pInput);

            if (!sUrl.includes('/app/common/scripting/scriptedrecord.nl')) {
                return fnNativeFetch(pInput, pInit);
            }

            const bForms = new URL(sUrl).searchParams.get('machine') === 'forms';
            const oSignal = pInit?.signal;

            oLog.fetches.push({
                url: sUrl,
                kind: bForms ? 'forms' : 'stack',
                credentials: pInit?.credentials,
                signal: oSignal instanceof AbortSignal,
                at: performance.now()
            });

            /* slow-forms: the forms request never answers; only the popup's AbortSignal ends it */
            if (bForms && oState.stallForms) {
                return new Promise((pResolve, pReject) => {

                    oSignal?.addEventListener('abort', () => {

                        oLog.aborted.push({kind: 'forms', at: performance.now()});
                        pReject(new DOMException('The operation was aborted.', 'AbortError'));
                    }, {once: true});
                });
            }

            nInFlight++;
            oLog.maxInFlight = Math.max(oLog.maxInFlight, nInFlight);
            await delay(40);
            nInFlight--;

            const sTypeId = new URL(sUrl).searchParams.get('id');
            const sFormsHtml = oState.formsHtmlByType[sTypeId] || pFormsHtml;

            return new Response(bForms ? sFormsHtml : pStackHtml, {
                status: 200,
                headers: {'Content-Type': 'text/html'}
            });
        };
    };

    /**
     * Imports the real popup.html body into this page.
     *
     * @param {string} pPopupHtml
     */
    const mountPopup = (pPopupHtml) => {

        const oPopupDoc = new DOMParser().parseFromString(pPopupHtml, 'text/html');

        Array.from(oPopupDoc.body.childNodes).forEach((pNode) => {

            document.body.appendChild(document.importNode(pNode, true));
        });
    };

    /**
     * Loads the real js/popup.js and fires DOMContentLoaded for it.
     *
     * @param {boolean} [pWaitForRender] - false: return right after DOMContentLoaded
     */
    const startPopup = async (pWaitForRender = true) => {

        await new Promise((pResolve, pReject) => {

            const oScript = document.createElement('script');
            oScript.src = 'js/popup.js';
            oScript.onload = pResolve;
            oScript.onerror = () => pReject(new Error('js/popup.js failed to load'));
            document.head.appendChild(oScript);
        });

        document.dispatchEvent(new Event('DOMContentLoaded'));

        if (!pWaitForRender) {
            return;
        }

        await waitFor(isRendered, 10000, 'popup render');
        await delay(100);
    };

    /**
     * Simulates closing and reopening the popup: fresh popup.html body, popup.js runs again
     * (its DOMContentLoaded listener), same fake chrome storage. Returns log offsets taken
     * before the reopen.
     *
     * @returns {Promise<{fetches: number, injects: number, replies: number}>}
     */
    const reopenPopup = async () => {

        const oMarks = {fetches: oLog.fetches.length, injects: oLog.injects.length, replies: oLog.replies.length};

        document.body.replaceChildren();
        mountPopup(oState.popupHtml);
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await waitFor(isRendered, 10000, 'popup reopen render');
        await delay(100);

        return oMarks;
    };

    /* ────────────────────────────────────────────────
     * Shared checks
     * ──────────────────────────────────────────────── */

    /**
     * Checks every payload item and expected form script: present with the right badge, or
     * absent when the Deployed filter hides it. No expected form scripts -> no Form Scripts group.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload - Payload the popup received
     * @param {boolean} pDeployedOnly
     * @param {Array} [pFormScripts] - Expected form scripts, defaults to the fixture's
     * @param {string} [pPhase] - Label suffix for multi-phase scenarios
     */
    const checkItems = (pFixture, pPayload, pDeployedOnly, pFormScripts = pFixture.expect.formScripts, pPhase = '') => {

        const sSuffix = (pDeployedOnly ? ' [Deployed filter]' : '') + (pPhase ? ` [${pPhase}]` : '');

        /**
         * True when the item should be rendered.
         *
         * @param {string} pState
         * @returns {boolean}
         */
        const isShown = (pState) => !pDeployedOnly || RUN_STATES.includes(pState);

        pPayload.SCRIPTS_DATA.forEach((pScript) => {

            const sKey = deploymentKey(pScript.DEPLOYMENT_URL);
            const sLabel = `Script ${pScript.DEPLOYMENT_ID} (#${sKey}) [${pScript.STATE}]${sSuffix}`;
            const oCard = findScriptCard(pScript.DEPLOYMENT_URL);

            if (!isShown(pScript.STATE)) {
                check(`${sLabel}: hidden`, !oCard, 'card is rendered');
                return;
            }

            if (!oCard) {
                check(`${sLabel}: rendered`, false, 'card not found');
                return;
            }

            checkBadge(sLabel, oCard, expectedBadge(pScript.STATE, pScript.STATUS, 'script'));

            const oLink = oCard.querySelector('.sm-deploy-id');
            const sFont = getComputedStyle(oLink).fontFamily.toLowerCase();
            check(
                `${sLabel}: deployment id links to the deployment record (new tab, full id in title, monospace)`,
                oLink.tagName === 'A' && oLink.href === pScript.DEPLOYMENT_URL && oLink.target === '_blank' &&
                    oLink.title === pScript.DEPLOYMENT_ID && sFont.includes('mono'),
                `href=${oLink.href} target=${oLink.target} title=${oLink.title} font=${sFont}`
            );
        });

        pPayload.WORKFLOWS_DATA.forEach((pWorkflow) => {

            const sLabel = `Workflow "${pWorkflow.WORKFLOW_NAME}" [${pWorkflow.STATE}]${sSuffix}`;
            const oCard = findNamedCard('Workflows', pWorkflow.WORKFLOW_NAME);

            if (!isShown(pWorkflow.STATE)) {
                check(`${sLabel}: hidden`, !oCard, 'card is rendered');
                return;
            }

            if (!oCard) {
                check(`${sLabel}: rendered`, false, 'card not found');
                return;
            }

            checkBadge(sLabel, oCard, expectedBadge(pWorkflow.STATE, pWorkflow.STATUS, 'workflow'));
        });

        if (pFormScripts.length === 0) {
            check(
                `No Form Scripts group when no form scripts are expected${sSuffix}`,
                !getSections().some((pSection) => pSection.title === 'Form Scripts'),
                'Form Scripts group rendered'
            );
        }

        pFormScripts.forEach((pForm) => {

            const sState = expectedFormState(pForm.formId, pPayload.CUSTOM_FORM_ID || '');
            const sLabel = `Form script "${pForm.scriptName}" [${sState}]${sSuffix}`;
            const oCard = findNamedCard('Form Scripts', pForm.scriptName);

            if (!isShown(sState)) {
                check(`${sLabel}: hidden`, !oCard, 'card is rendered');
                return;
            }

            if (!oCard) {
                check(`${sLabel}: rendered`, false, 'card not found');
                return;
            }

            checkBadge(sLabel, oCard, expectedBadge(sState, '', 'form'));

            const oNameLink = oCard.querySelector('.card-name a');

            if (pForm.scriptUrl) {
                check(
                    `${sLabel}: script link resolved to the NetSuite origin`,
                    !!oNameLink && oNameLink.href === pForm.scriptUrl && oNameLink.target === '_blank' &&
                        new URL(oNameLink.href).origin === pFixture.origin,
                    `href=${oNameLink?.href}`
                );
            } else {
                check(
                    `${sLabel}: no script link when the Script cell has no anchor`,
                    !oNameLink && oCard.querySelector('.card-name-text')?.textContent === pForm.scriptName,
                    `link=${oNameLink?.href}`
                );
            }

            const oFormRef = oCard.querySelector('.card-meta .sm-form-ref');
            const oFormLink = oFormRef?.querySelector('a');

            if (pForm.formUrl) {
                check(
                    `${sLabel}: "Form: ${pForm.formName}" links to the form, resolved to the NetSuite origin`,
                    !!oFormLink && oFormRef.textContent === `Form: ${pForm.formName}` &&
                        oFormLink.href === pForm.formUrl && oFormLink.target === '_blank' &&
                        new URL(oFormLink.href).origin === pFixture.origin,
                    `text=${oFormRef?.textContent} href=${oFormLink?.href}`
                );
            } else {
                check(
                    `${sLabel}: "Form: ${pForm.formName}" as plain text when the Form link does not resolve`,
                    !oFormLink && oFormRef?.textContent === `Form: ${pForm.formName}`,
                    `text=${oFormRef?.textContent} href=${oFormLink?.href}`
                );
            }

            checkEqual(
                `${sLabel}: hook tags`,
                [...oCard.querySelectorAll('.card-hooks .sm-hook-tag')].map((pTag) => pTag.textContent),
                pForm.hooks
            );
        });

        pFixture.expect.formsWithoutScript.forEach((pFormName) => {

            const bListed = getSectionCards('Form Scripts').some((pCard) =>
                pCard.querySelector('.sm-form-ref')?.textContent === `Form: ${pFormName}`
            );
            check(`Form "${pFormName}" without a script is not listed`, !bListed, 'listed');
        });

        check(
            'No "Custom GL Lines (Plug-in)" group',
            !getSections().some((pSection) => pSection.title.includes('Custom GL')),
            getSections().map((pSection) => pSection.title).join(', ')
        );
    };

    /**
     * Checks the scriptedrecord.nl requests made by the popup.
     *
     * @param {Object} pPayload
     * @param {boolean} pExpectStack
     */
    const checkFetches = (pPayload, pExpectStack) => {

        const aForms = oLog.fetches.filter((pFetch) => pFetch.kind === 'forms');
        const aStack = oLog.fetches.filter((pFetch) => pFetch.kind === 'stack');
        const oFormsUrl = aForms[0] ? new URL(aForms[0].url) : null;

        check(
            'Forms fragment fetched once (r=T, id=<RECORD_TYPE>, machine=forms, credentials include)',
            aForms.length === 1 && oFormsUrl.searchParams.get('r') === 'T' &&
                oFormsUrl.searchParams.get('id') === pPayload.RECORD_TYPE.toUpperCase() &&
                oFormsUrl.searchParams.get('machine') === 'forms' && aForms[0].credentials === 'include',
            JSON.stringify(aForms)
        );

        if (pExpectStack) {
            check(
                'Stack order page fetched once (credentials include)',
                aStack.length === 1 && aStack[0].credentials === 'include',
                JSON.stringify(aStack)
            );
            check(
                'Stack order and forms fetches run in parallel',
                oLog.maxInFlight >= 2,
                `max in flight ${oLog.maxInFlight}`
            );
        } else {
            check('Stack order page not fetched without deployments', aStack.length === 0, JSON.stringify(aStack));
        }

        check(
            'Every scriptedrecord.nl request carries an AbortSignal (bounded by the popup timeout)',
            oLog.fetches.length > 0 && oLog.fetches.every((pFetch) => pFetch.signal),
            JSON.stringify(oLog.fetches)
        );
    };

    /**
     * Checks the fixture's expected stack order per script group (deployment id text sequence).
     *
     * @param {Object} pFixture
     */
    const checkStackOrder = (pFixture) => {

        Object.entries(pFixture.expect.stackOrder).forEach(([pGroup, pIds]) => {

            checkEqual(
                `Stack order applied to ${pGroup} Scripts`,
                getSectionCards(pGroup + ' Scripts').map((pCard) => pCard.querySelector('.sm-deploy-id').textContent),
                pIds
            );
        });
    };

    /**
     * Deployment id truncation: ellipsis styling always; actual clipping only when the fixture's
     * truncatedDeploymentId is wider than the space its meta row leaves for it.
     *
     * @param {Object} pFixture
     */
    const checkTruncation = (pFixture) => {

        const sId = pFixture.expect.truncatedDeploymentId;

        if (!sId) {
            return;
        }

        const oLink = [...document.querySelectorAll('#scriptCards .sm-deploy-id')]
            .find((pEl) => pEl.textContent === sId);

        if (!oLink) {
            check(`Deployment id "${sId}" rendered for the truncation check`, false, 'not found');
            return;
        }

        const oStyle = getComputedStyle(oLink);
        check(
            'Deployment id styled to truncate (text-overflow ellipsis, overflow hidden, nowrap)',
            oStyle.textOverflow === 'ellipsis' && oStyle.overflowX === 'hidden' && oStyle.whiteSpace === 'nowrap',
            `text-overflow=${oStyle.textOverflow} overflow=${oStyle.overflowX} white-space=${oStyle.whiteSpace}`
        );

        /* Space left for the id = meta row content width minus siblings and flex gaps */
        const oMeta = oLink.parentElement;
        const oMetaStyle = getComputedStyle(oMeta);
        const aSiblings = [...oMeta.children].filter((pChild) => pChild !== oLink);
        const nSiblingsWidth = aSiblings.reduce((pSum, pChild) => pSum + pChild.getBoundingClientRect().width, 0);
        const nGaps = (parseFloat(oMetaStyle.columnGap) || 0) * aSiblings.length;
        const nPadding = parseFloat(oMetaStyle.paddingLeft) + parseFloat(oMetaStyle.paddingRight);
        const nAvailable = oMeta.clientWidth - nPadding - nSiblingsWidth - nGaps;

        /* Natural single-line width of the id in the link's font */
        const oContext = document.createElement('canvas').getContext('2d');
        oContext.font = oStyle.font;
        const nNatural = oContext.measureText(sId).width;

        if (nNatural <= nAvailable + 1) {
            check(
                `Deployment id "${sId}" fits (${nNatural.toFixed(0)}px <= ${nAvailable.toFixed(0)}px), no clip needed`,
                true
            );
            return;
        }

        check(
            `Long deployment id clipped with ellipsis (${nNatural.toFixed(0)}px > ${nAvailable.toFixed(0)}px)`,
            oLink.scrollWidth > oLink.clientWidth && oLink.clientWidth <= nAvailable + 1,
            `scrollWidth=${oLink.scrollWidth} clientWidth=${oLink.clientWidth}`
        );
    };

    /**
     * Expected section header texts for the default group order.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     * @returns {string[]}
     */
    const expectedSectionTitles = (pFixture, pPayload) => {

        const aGroups = [...new Set(pPayload.SCRIPTS_DATA.map((pScript) => pScript.SCRIPT_TYPE))];

        if (pFixture.expect.formScripts.length > 0) {
            aGroups.push('Form Scripts');
        }

        if (pPayload.WORKFLOWS_DATA.length > 0) {
            aGroups.push('Workflows');
        }

        const aKnown = DEFAULT_GROUP_ORDER.filter((pGroup) => aGroups.includes(pGroup));
        const aUnknown = aGroups
            .filter((pGroup) => !DEFAULT_GROUP_ORDER.includes(pGroup))
            .sort((pA, pB) => pA.localeCompare(pB));

        return [...aKnown, ...aUnknown].map((pGroup) => {

            return (pGroup === 'Form Scripts' || pGroup === 'Workflows') ? pGroup : pGroup + ' Scripts';
        });
    };

    /**
     * Opens the settings drawer and returns the group labels.
     *
     * @returns {string[]}
     */
    const readDrawerGroups = () => {

        document.getElementById('settingsBtn').click();
        const aLabels = [...document.querySelectorAll('#groupOrderList .sm-order-label')]
            .map((pLabel) => pLabel.textContent);
        document.getElementById('settingsBtn').click();
        return aLabels;
    };

    /* ────────────────────────────────────────────────
     * Scenarios
     * ──────────────────────────────────────────────── */

    /**
     * record: every state, current/other form, stack order, links, drawer, dark mode.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     */
    const runRecordChecks = (pFixture, pPayload) => {

        checkFetches(pPayload, true);
        checkItems(pFixture, pPayload, false);

        checkEqual(
            'Fresh storage: groups render in the default order (Client, Form Scripts, User Event, Workflows, ...)',
            getSections().map((pSection) => pSection.title),
            expectedSectionTitles(pFixture, pPayload)
        );

        /* With zero expected form scripts, checkItems already asserts the group is absent */
        if (pFixture.expect.formScripts.length > 0) {

            checkEqual(
                'Form Scripts count excludes forms without a script',
                getSections().find((pSection) => pSection.title === 'Form Scripts')?.count,
                `(${pFixture.expect.formScripts.length})`
            );

            checkEqual(
                'Form Scripts keep source order under Stack Order sort',
                getSectionCards('Form Scripts').map((pCard) => pCard.querySelector('.card-name').textContent.trim()),
                pFixture.expect.formScripts.map((pForm) => pForm.scriptName)
            );
        }

        checkStackOrder(pFixture);
        checkTruncation(pFixture);

        const aDrawer = readDrawerGroups();
        checkEqual('Fresh storage: Settings drawer shows the default group order', aDrawer, DEFAULT_GROUP_ORDER);

        check('Scripted Records button enabled', !document.getElementById('scriptedRecordsBtn').disabled, 'disabled');

        const sFooter = document.getElementById('footerVersion').textContent;
        check(
            'Footer shows manifest version, no sponsor block',
            sFooter.endsWith('v' + chrome.runtime.getManifest().version) &&
                !document.querySelector('.sm-footer-sponsor, .sm-sponsor-text, .sm-sponsor-logo'),
            sFooter
        );

        /* Amber badge/dot readable in both themes */
        const oTestingCard = [...document.querySelectorAll('#scriptCards .script-card')]
            .find((pCard) => pCard.querySelector('.sm-badge.testing'));
        const oGreenDot = document.querySelector('#scriptCards .sm-deployed-dot:not(.testing)');

        if (!oTestingCard || !oGreenDot) {
            check('Testing badge and green dot present for contrast check', false, 'missing');
            return;
        }

        ['light', 'dark'].forEach((pTheme) => {

            if (pTheme === 'dark') {
                document.getElementById('darkToggle').click();
            }

            const oBadgeStyle = getComputedStyle(oTestingCard.querySelector('.sm-badge'));
            const sAmberDot = getComputedStyle(oTestingCard.querySelector('.sm-deployed-dot')).backgroundColor;
            const sGreenDot = getComputedStyle(oGreenDot).backgroundColor;
            const sCardBg = getComputedStyle(oTestingCard).backgroundColor;
            const nBadgeContrast = contrastRatio(oBadgeStyle.color, oBadgeStyle.backgroundColor);
            const nDotContrast = contrastRatio(sAmberDot, sCardBg);

            check(
                `Testing badge contrast >= ${MIN_CONTRAST} (${pTheme})`,
                nBadgeContrast >= MIN_CONTRAST,
                `${nBadgeContrast.toFixed(2)} (${oBadgeStyle.color} on ${oBadgeStyle.backgroundColor})`
            );
            check(
                `Amber dot distinct from green dot and visible on the card (${pTheme})`,
                sAmberDot !== sGreenDot && nDotContrast >= 3,
                `amber=${sAmberDot} green=${sGreenDot} contrast=${nDotContrast.toFixed(2)}`
            );
        });

        document.getElementById('darkToggle').click();
    };

    /* ── Settings drawer vs scheduler view exclusivity (PLAN section 12) ── */

    /**
     * True when the element is displayed (inline style and computed style).
     *
     * @param {HTMLElement} pEl
     * @returns {boolean}
     */
    const isDisplayed = (pEl) => pEl.style.display !== 'none' && getComputedStyle(pEl).display !== 'none';

    /**
     * Snapshot of the toolbar buttons, drawer, scheduler views and main view.
     *
     * @returns {Object}
     */
    const readViews = () => {

        return {
            settingsActive: document.getElementById('settingsBtn').classList.contains('active'),
            schedulerActive: document.getElementById('schedulerBtn').classList.contains('active'),
            drawer: document.getElementById('settingsDrawer').style.display === 'block',
            warning: document.getElementById('schedulerWarning').style.display === 'block',
            panel: document.getElementById('schedulerPanel').style.display === 'block',
            cards: isDisplayed(document.getElementById('scriptCards')),
            footer: isDisplayed(document.querySelector('.sm-footer'))
        };
    };

    /**
     * Asserts the views match pExpected (only the listed keys).
     *
     * @param {string} pLabel
     * @param {Object} pExpected
     */
    const checkViews = (pLabel, pExpected) => {

        const oActual = readViews();
        const aDiffs = Object.keys(pExpected)
            .filter((pKey) => oActual[pKey] !== pExpected[pKey])
            .map((pKey) => `${pKey}=${oActual[pKey]} (want ${pExpected[pKey]})`);

        check(pLabel, aDiffs.length === 0, aDiffs.join('; '));
    };

    /**
     * Clicks the scheduler button and waits for its async open/close to settle.
     *
     * @param {boolean} pExpectOpen
     */
    const clickScheduler = async (pExpectOpen) => {

        document.getElementById('schedulerBtn').click();

        await waitFor(() => {

            const oViews = readViews();
            return (oViews.warning || oViews.panel) === pExpectOpen;
        }, 3000, 'scheduler view toggle');
        await delay(50);
    };

    /**
     * Both switch directions for the safety warning (fresh storage) and the stored-data panel;
     * closing either view never opens the other.
     */
    const runExclusivityChecks = async () => {

        const oSettingsBtn = document.getElementById('settingsBtn');
        const oMainView = {cards: true, footer: true};

        await clickScheduler(true);
        checkViews('Sync opened (no stored data): safety warning shown, main view hidden', {
            schedulerActive: true, warning: true, panel: false, cards: false, footer: false
        });

        oSettingsBtn.click();
        checkViews('Settings opened over the warning: warning closed, Sync inactive, cards visible again', {
            settingsActive: true, drawer: true, schedulerActive: false, warning: false, panel: false, ...oMainView
        });

        await clickScheduler(true);
        checkViews('Sync opened over Settings: drawer closed, Settings inactive, warning shown', {
            settingsActive: false, drawer: false, schedulerActive: true, warning: true
        });

        await clickScheduler(false);
        checkViews('Closing Sync does not open Settings', {
            settingsActive: false, drawer: false, schedulerActive: false, warning: false, panel: false, ...oMainView
        });

        oSettingsBtn.click();
        oSettingsBtn.click();
        checkViews('Closing Settings does not open Sync', {
            settingsActive: false, drawer: false, schedulerActive: false, warning: false, panel: false, ...oMainView
        });

        /* Stored deployments open the panel instead of the warning */
        oStore.scheduledDeployments = [{
            internalId: '9001',
            deploymentId: 'customdeploy_harness_scheduled',
            title: 'Harness Scheduled Deployment',
            scriptName: 'Harness Scheduled Script'
        }];

        oSettingsBtn.click();
        await clickScheduler(true);
        checkViews('Sync opened over Settings (stored data): drawer closed, Settings inactive, panel shown', {
            settingsActive: false, drawer: false, schedulerActive: true, warning: false, panel: true, cards: false
        });

        oSettingsBtn.click();
        checkViews('Settings opened over the panel: panel closed, Sync inactive, cards visible again', {
            settingsActive: true, drawer: true, schedulerActive: false, warning: false, panel: false, ...oMainView
        });

        oSettingsBtn.click();
        delete oStore.scheduledDeployments;
    };

    /**
     * Pending-open race (PLAN section 13): Settings clicked while the Sync handler still awaits
     * chrome.storage.local.get must win; the stale Sync open shows nothing once storage resolves.
     * Runs for the warning path (no stored data) and the panel path (stored data).
     */
    const runPendingOpenChecks = async () => {

        const oSettingsBtn = document.getElementById('settingsBtn');

        for (const bStoredData of [false, true]) {

            const sPath = bStoredData ? 'panel' : 'warning';

            if (bStoredData) {
                oStore.scheduledDeployments = [{
                    internalId: '9001',
                    deploymentId: 'customdeploy_harness_scheduled',
                    title: 'Harness Scheduled Deployment',
                    scriptName: 'Harness Scheduled Script'
                }];
            }

            oState.deferSchedulerGet = true;
            oState.releaseSchedulerGet = null;
            document.getElementById('schedulerBtn').click();
            await waitFor(() => !!oState.releaseSchedulerGet, 3000, 'deferred scheduler storage read');

            oSettingsBtn.click();
            oState.releaseSchedulerGet();
            await delay(150);

            checkViews(`Settings clicked during the Sync storage read (${sPath} path): Sync view stays closed`, {
                drawer: true,
                settingsActive: true,
                schedulerActive: false,
                warning: false,
                panel: false,
                cards: true,
                footer: true
            });

            oSettingsBtn.click();
            delete oStore.scheduledDeployments;
        }

        await clickScheduler(true);
        await clickScheduler(false);
        checkViews('Sync still opens and closes normally after a cancelled open', {
            drawer: false, settingsActive: false, schedulerActive: false, warning: false, panel: false, cards: true
        });
    };

    /* ── count-warnings: Client limit / UE advisory on running deployments (PLAN section 10) ── */

    const CLIENT_PREFERENCE_SENTENCE = 'Administrators can remove this limit with the Remove Client Script ' +
        'Deployment Limit per Record preference (NetSuite 2026.2+).';
    const CLIENT_LIMIT_TIP = 'By default, a maximum of 10 Client scripts can be deployed per record. ' +
        'Scripts beyond this limit will not execute. ' + CLIENT_PREFERENCE_SENTENCE;
    const CLIENT_APPROACH_TIP = 'Approaching the default limit of 10 Client scripts per record. ' +
        CLIENT_PREFERENCE_SENTENCE;
    const UE_ADVISORY_TIP = 'Avoid assigning too many scripts to one record type. ' +
        'A high number of User Event scripts can increase load and save times.';

    /**
     * STATE list: running deployments followed by non-running ones (undeployed, script inactive,
     * not released, cycling).
     *
     * @param {number} pActive
     * @param {number} pTesting
     * @param {number} pNotRunning
     * @returns {string[]}
     */
    const makeStates = (pActive, pTesting, pNotRunning) => {

        const aNotRunning = ['undeployed', 'script_inactive', 'not_released'];

        return [
            ...Array(pActive).fill('active'),
            ...Array(pTesting).fill('testing'),
            ...Array.from({length: pNotRunning}, (pUnused, pIndex) => aNotRunning[pIndex % aNotRunning.length])
        ];
    };

    const WARNING_PHASES = [
        {
            label: '(a) 12 Client, 7 running, limit in force',
            client: makeStates(7, 0, 5), ue: [], limitRemoved: false, expectClient: null
        },
        {
            label: '(b) 12 Client, 10 running, CLIENT_LIMIT_REMOVED false',
            client: makeStates(8, 2, 2), ue: [], limitRemoved: false,
            expectClient: {look: 'danger', text: 'LIMIT', tip: CLIENT_LIMIT_TIP}
        },
        {
            label: '(c) 12 Client, 10 running, CLIENT_LIMIT_REMOVED true',
            client: makeStates(8, 2, 2), ue: [], limitRemoved: true, expectClient: null
        },
        {
            label: '(d1) 12 User Event, 9 running',
            client: [], ue: makeStates(8, 1, 3), limitRemoved: false, expectUe: null
        },
        {
            label: '(d2) 12 User Event, 10 running',
            client: [], ue: makeStates(9, 1, 2), limitRemoved: false,
            expectUe: {look: 'warn', text: '10', tip: UE_ADVISORY_TIP}
        },
        {
            label: '(e) 13 Client, 9 running, CLIENT_LIMIT_REMOVED false',
            client: makeStates(7, 2, 4), ue: [], limitRemoved: false,
            expectClient: {look: 'warn', text: '9', tip: CLIENT_APPROACH_TIP},
            alsoDeployedFilter: true
        },
        {
            label: '(f) 10 Client, 10 running, CLIENT_LIMIT_REMOVED null',
            client: makeStates(10, 0, 0), ue: [], limitRemoved: null,
            expectClient: {look: 'danger', text: 'LIMIT', tip: CLIENT_LIMIT_TIP}
        }
    ];

    /**
     * Builds a synthetic payload for one warning phase.
     *
     * @param {Object} pFixture
     * @param {Object} pPhase - WARNING_PHASES entry
     * @returns {Object}
     */
    const buildWarningPayload = (pFixture, pPhase) => {

        const oPayload = structuredClone(pFixture.payload);
        const oStatusByState = {active: 'Released', testing: 'Testing', not_released: 'Not Scheduled'};
        let nId = 800;

        /**
         * Synthetic deployments of one script type.
         *
         * @param {string} pType
         * @param {string[]} pStates
         * @returns {Object[]}
         */
        const makeScripts = (pType, pStates) => pStates.map((pState) => {

            nId++;

            return {
                ID: nId,
                SCRIPT: nId + 1000,
                DEPLOYMENT_ID: `customdeploy_warn_${nId}`,
                SCRIPT_NAME: `${pType} Warning Sample ${nId}`,
                SCRIPT_TYPE: pType,
                DEPLOYED: pState !== 'undeployed',
                STATUS: oStatusByState[pState] || 'Released',
                INACTIVE: pState === 'script_inactive',
                STATE: pState,
                URL: `${pFixture.origin}/app/common/scripting/script.nl?id=${nId + 1000}&whence=`,
                DEPLOYMENT_URL: `${pFixture.origin}/app/common/scripting/scriptrecord.nl?id=${nId}`,
                FILE_URL: `${pFixture.origin}/app/common/record/edittextmediaitem.nl?id=${nId + 2000}&e=T`,
                INFO: 'N/A',
                HIDE_IN_BUNDLE: false
            };
        });

        oPayload.SCRIPTS_DATA = [...makeScripts('Client', pPhase.client), ...makeScripts('User Event', pPhase.ue)];
        oPayload.CLIENT_LIMIT_REMOVED = pPhase.limitRemoved;
        return oPayload;
    };

    /**
     * Asserts the header count and warning badge of one script group.
     *
     * @param {string} pLabel
     * @param {string} pTitle - Section header text
     * @param {number} pRenderedCount - Expected "(N)" header count
     * @param {Object|null|undefined} pExpect - {look, text, tip}; falsy = no badge
     */
    const checkWarning = (pLabel, pTitle, pRenderedCount, pExpect) => {

        const oSection = getSections().find((pSection) => pSection.title === pTitle);

        if (!oSection) {
            check(`${pLabel}: ${pTitle} group rendered`, false, 'missing');
            return;
        }

        checkEqual(`${pLabel}: ${pTitle} header count shows rendered cards`, oSection.count, `(${pRenderedCount})`);

        const oWarn = oSection.header.querySelector('.sm-count-warn');
        const sBadge = oWarn?.firstChild?.nodeValue || '';

        if (!pExpect) {
            check(`${pLabel}: no ${pTitle} warning badge`, !oWarn, `badge "${sBadge}" shown`);
            return;
        }

        check(
            `${pLabel}: ${pTitle} ${pExpect.look} badge "${pExpect.text}"`,
            !!oWarn && oWarn.classList.contains(pExpect.look) && sBadge === pExpect.text,
            `class="${oWarn?.className}" text="${sBadge}"`
        );
        checkEqual(
            `${pLabel}: ${pTitle} warning tooltip`,
            oWarn?.querySelector('.sm-warn-tooltip span')?.textContent,
            pExpect.tip
        );
        check(
            `${pLabel}: ${pTitle} warning keeps the docs link`,
            !!oWarn?.querySelector('.sm-warn-tooltip a[href^="https://docs.oracle.com/"]'),
            'link missing'
        );
    };

    /**
     * count-warnings: runs every WARNING_PHASES case; the first is already rendered, the rest
     * are loaded through the Refresh button.
     *
     * @param {Object} pFixture
     */
    const runCountWarningChecks = async (pFixture) => {

        for (let nPhase = 0; nPhase < WARNING_PHASES.length; nPhase++) {

            const oPhase = WARNING_PHASES[nPhase];

            if (nPhase > 0) {
                oState.response = {type: 'SCRIPTS_DATA', error: null, data: buildWarningPayload(pFixture, oPhase)};
                document.getElementById('refreshBtn').click();
                await waitFor(isRendered, 10000, `refresh render ${oPhase.label}`);
                await delay(100);
            }

            if (oPhase.client.length > 0) {
                checkWarning(oPhase.label, 'Client Scripts', oPhase.client.length, oPhase.expectClient);
            }

            if (oPhase.ue.length > 0) {
                checkWarning(oPhase.label, 'User Event Scripts', oPhase.ue.length, oPhase.expectUe);
            }

            if (oPhase.alsoDeployedFilter) {

                const nRunning = oPhase.client.filter((pState) => pState === 'active' || pState === 'testing').length;

                document.getElementById('deployedToggle').click();
                checkWarning(`${oPhase.label} [Deployed filter]`, 'Client Scripts', nRunning, oPhase.expectClient);
                document.getElementById('deployedToggle').click();
            }
        }
    };

    /* ── Footer brand link (PLAN section 16) ── */

    /**
     * Footer brand link: markup, footer look in both themes, and one click = exactly one
     * chrome.tabs.create with the default navigation prevented.
     *
     * @param {string} pLabel
     */
    const checkFooterLink = async (pLabel) => {

        const oLink = document.getElementById('footerBrandLink');

        check(
            `${pLabel}: footer brand links to ${BRAND_ORIGIN} (logo + text, new tab, noopener noreferrer)`,
            !!oLink && oLink.tagName === 'A' && new URL(oLink.href).origin === BRAND_ORIGIN &&
                oLink.target === '_blank' && oLink.rel === 'noopener noreferrer' &&
                oLink.textContent.includes('by Alien Technology LLC') && !!oLink.querySelector('img.sm-footer-logo'),
            oLink ? `href=${oLink.href} target=${oLink.target} rel=${oLink.rel}` : 'no #footerBrandLink'
        );

        if (!oLink) {
            return;
        }

        const oFooterText = document.getElementById('footerVersion');
        const aLook = [];

        /* Links animate color changes; measure the settled color, not a transition frame */
        oLink.style.transition = 'none';

        for (const sTheme of ['light', 'dark']) {

            document.body.classList.toggle('theme-dark', sTheme === 'dark');
            await delay(50);

            const oStyle = getComputedStyle(oLink);
            aLook.push({
                theme: sTheme,
                sameColor: oStyle.color === getComputedStyle(oFooterText).color,
                underline: oStyle.textDecorationLine
            });
        }

        document.body.classList.remove('theme-dark');
        oLink.style.transition = '';
        await delay(50);

        check(
            `${pLabel}: footer brand keeps the footer color and no underline (light and dark)`,
            aLook.every((pLook) => pLook.sameColor && pLook.underline === 'none'),
            JSON.stringify(aLook)
        );

        const nBefore = oLog.tabsCreated.length;
        const oEvent = new MouseEvent('click', {bubbles: true, cancelable: true});
        oLink.dispatchEvent(oEvent);
        const aCreated = oLog.tabsCreated.slice(nBefore);

        check(
            `${pLabel}: one click opens exactly one tab via chrome.tabs.create; default navigation prevented`,
            aCreated.length === 1 && new URL(aCreated[0]).origin === BRAND_ORIGIN && oEvent.defaultPrevented,
            `created=${JSON.stringify(aCreated)} defaultPrevented=${oEvent.defaultPrevented}`
        );
    };

    /* ── cache / no-session: record-type cache (PLAN section 14) ── */

    /**
     * Sorted kinds ('forms' / 'stack') of the scriptedrecord.nl fetches made since a log mark.
     *
     * @param {number} pMark
     * @returns {string[]}
     */
    const fetchKindsSince = (pMark) => oLog.fetches.slice(pMark).map((pFetch) => pFetch.kind).sort();

    /**
     * cache: miss, hit, per-record form state on hits, stale reply, null-part fill, expiry,
     * Refresh, forced re-requests, error payloads and a record type without form scripts.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     */
    const runCacheChecks = async (pFixture, pPayload) => {

        const sTypeKey = `${pPayload.ROLE_ID}|${pPayload.RECORD_TYPE.toUpperCase()}`;
        const sCacheKey = `${pFixture.origin}|${sTypeKey}`;

        /* Phases change the served payload; keep pPayload as the untouched reference */
        oState.response.data = structuredClone(pPayload);
        const nFormRows = pFixture.expect.formScripts.length;
        const nT0 = oClock.now;

        /**
         * Current Refresh button tooltip.
         *
         * @returns {string}
         */
        const getRefreshTitle = () => document.getElementById('refreshBtn').title;

        /**
         * Asserts the request kinds of one open: cache keys sent and reply kind per request.
         *
         * @param {string} pLabel
         * @param {Object} pMarks - reopenPopup() log offsets
         * @param {Array<{keyed: boolean, reply: string}>} pExpected
         */
        const checkRequests = (pLabel, pMarks, pExpected) => {

            const aActual = oLog.injects.slice(pMarks.injects).map((pInject, pIndex) => ({
                keyed: pInject.cacheKeys.includes(sTypeKey),
                reply: oLog.replies[pMarks.replies + pIndex]
            }));
            checkEqual(pLabel, aActual, pExpected);
        };

        /* 1. First open: miss */
        const oEntry = oSession[sCacheKey];
        checkRequests('Miss: one request without cache keys, full payload', {injects: 0, replies: 0}, [
            {keyed: false, reply: 'full'}
        ]);
        checkEqual('Miss: both scriptedrecord.nl pages fetched', fetchKindsSince(0), ['forms', 'stack']);
        check(
            'Miss: entry written (savedAt, deployments/workflows, stack pairs, form rows without state, no HTML)',
            !!oEntry && oEntry.savedAt === nT0 &&
                oEntry.payload.SCRIPTS_DATA.length === pPayload.SCRIPTS_DATA.length &&
                oEntry.payload.WORKFLOWS_DATA.length === pPayload.WORKFLOWS_DATA.length &&
                oEntry.payload.API_VERSION === pPayload.API_VERSION &&
                Object.keys(oEntry.payload).length === 3 &&
                Array.isArray(oEntry.stackOrder) && oEntry.stackOrder.length > 0 &&
                Array.isArray(oEntry.formScripts) && oEntry.formScripts.length === nFormRows &&
                oEntry.formScripts.every((pRow) => !('STATE' in pRow)) &&
                oEntry.payload.SCRIPTS_DATA.every((pScript) => !('STACK_ORDER' in pScript)) &&
                !JSON.stringify(oEntry).includes('<'),
            JSON.stringify(oEntry || null).slice(0, 400)
        );
        checkEqual('Miss: Refresh tooltip', getRefreshTitle(), 'Refresh data');

        const sFreshView = snapshotView();

        /* 2. Reopen within the TTL: hit */
        oClock.now += 30000;
        let oMarks = await reopenPopup();
        checkRequests('Hit (30 s): fresh key sent, light payload', oMarks, [{keyed: true, reply: 'light'}]);
        checkEqual('Hit: zero scriptedrecord.nl fetches', fetchKindsSince(oMarks.fetches), []);
        check('Hit: renders identically to the fresh render', snapshotView() === sFreshView, 'render differs');
        checkItems(pFixture, pPayload, false, undefined, 'hit, form 11');
        checkEqual('Hit: Refresh tooltip shows the entry age', getRefreshTitle(), 'Cached 30s ago - click to refresh');
        checkEqual('Hit: savedAt unchanged', oSession[sCacheKey]?.savedAt, nT0);

        /* 3. Hit on another record of the same type with a different form */
        oState.response.data.CUSTOM_FORM_ID = '12';
        oClock.now += 5000;
        oMarks = await reopenPopup();
        checkRequests('Hit on a record using form 12: light payload', oMarks, [{keyed: true, reply: 'light'}]);
        checkEqual('Hit on a record using form 12: zero fetches', fetchKindsSince(oMarks.fetches), []);
        checkItems(pFixture, {...pPayload, CUSTOM_FORM_ID: '12'}, false, undefined, 'hit, form 12');
        oState.response.data.CUSTOM_FORM_ID = pPayload.CUSTOM_FORM_ID;

        /* 4. A reply carrying an old request id is ignored */
        oState.staleReplies = [{
            type: 'SCRIPTS_DATA',
            requestId: 'stale-request-id',
            error: null,
            data: {...structuredClone(pPayload), SCRIPTS_DATA: [], WORKFLOWS_DATA: [{
                WORKFLOW: '699', WORKFLOW_NAME: 'Stale Reply Workflow', STATUS: 'Released', STATE: 'active',
                URL: `${pFixture.origin}/app/common/workflow/setup/workflowmanager.nl?id=699`, EDIT_URL: ''
            }]}
        }];
        oClock.now += 5000;
        oMarks = await reopenPopup();
        check(
            'Stale reply (old request id) is ignored; the current reply renders',
            oLog.staleServed === 1 && snapshotView() === sFreshView &&
                !document.getElementById('scriptCards').textContent.includes('Stale Reply Workflow'),
            `stale served ${oLog.staleServed}`
        );

        /* 5. Entry with a failed (null) part: only that part is fetched; savedAt is kept */
        oSession[sCacheKey].formScripts = null;
        oClock.now += 5000;
        oMarks = await reopenPopup();
        checkEqual(
            'Hit with formScripts null: only the forms fragment is fetched',
            fetchKindsSince(oMarks.fetches),
            ['forms']
        );
        check(
            'Filling formScripts updates the entry but keeps savedAt (no TTL extension)',
            oSession[sCacheKey]?.savedAt === nT0 && oSession[sCacheKey]?.formScripts?.length === nFormRows,
            JSON.stringify({savedAt: oSession[sCacheKey]?.savedAt, nT0})
        );
        check('Hit with formScripts null: render unchanged', snapshotView() === sFreshView, 'render differs');

        oSession[sCacheKey].stackOrder = null;
        oClock.now += 5000;
        oMarks = await reopenPopup();
        checkEqual(
            'Hit with stackOrder null: only the stack page is fetched',
            fetchKindsSince(oMarks.fetches),
            ['stack']
        );
        check(
            'Filling stackOrder keeps savedAt; stack order still applied',
            oSession[sCacheKey]?.savedAt === nT0 && oSession[sCacheKey]?.stackOrder?.length > 0 &&
                snapshotView() === sFreshView,
            `savedAt=${oSession[sCacheKey]?.savedAt}`
        );

        /* 6. Expired entry: full run */
        oClock.now = nT0 + CACHE_TTL_MS + 1000;
        oMarks = await reopenPopup();
        checkRequests('Expired entry: no key sent, full payload', oMarks, [{keyed: false, reply: 'full'}]);
        checkEqual('Expired entry: both pages fetched again', fetchKindsSince(oMarks.fetches), ['forms', 'stack']);
        checkEqual('Expired entry: rewritten with a new savedAt', oSession[sCacheKey]?.savedAt, oClock.now);
        checkEqual('Expired entry: Refresh tooltip', getRefreshTitle(), 'Refresh data');

        /* 7. Refresh bypasses a fresh entry and overwrites it */
        oClock.now += 10000;
        oMarks = {fetches: oLog.fetches.length, injects: oLog.injects.length, replies: oLog.replies.length};
        document.getElementById('refreshBtn').click();
        await waitFor(isRendered, 10000, 'refresh render');
        await delay(100);
        checkRequests('Refresh: no key sent although the entry is fresh, full payload', oMarks, [
            {keyed: false, reply: 'full'}
        ]);
        checkEqual('Refresh: both pages fetched', fetchKindsSince(oMarks.fetches), ['forms', 'stack']);
        checkEqual('Refresh: entry overwritten (savedAt = now)', oSession[sCacheKey]?.savedAt, oClock.now);

        /* 8. Light reply without a matching entry: exactly one forced re-request */
        delete oSession[sCacheKey];
        oState.forceLightOnce = true;
        oClock.now += 1000;
        oMarks = await reopenPopup();
        checkRequests('Light reply with a missing entry: one forced re-request', oMarks, [
            {keyed: false, reply: 'light'},
            {keyed: false, reply: 'full'}
        ]);
        check('Forced re-request renders the full result', snapshotView() === sFreshView, 'render differs');

        /* 8b. Entry expires between sending the key and receiving the light reply */
        oState.advanceClockOnReply = CACHE_TTL_MS;
        oMarks = await reopenPopup();
        checkRequests('Entry expired before the light reply: one forced re-request', oMarks, [
            {keyed: true, reply: 'light'},
            {keyed: false, reply: 'full'}
        ]);
        check('Re-request after expiry renders the full result', snapshotView() === sFreshView, 'render differs');

        /* 9. Payload with a search error is not cached */
        Object.keys(oSession).forEach((pKey) => {

            delete oSession[pKey];
        });
        oState.response.data.SCRIPT_ERROR = 'Synthetic search error';
        oMarks = await reopenPopup();
        check(
            'Error payload: rendered with the error row and not cached',
            !!document.querySelector('#scriptCards .sm-error-row') && Object.keys(oSession).length === 0,
            JSON.stringify(Object.keys(oSession))
        );
        oState.response.data.SCRIPT_ERROR = '';

        /* 10. Record type without form scripts: [] is cached and a hit needs no fetch */
        if (!oState.formsHtmlByType.INVOICE) {
            check('Fixture provides formsEmptyHtml for the no-form-scripts case', false, 'missing');
            return;
        }

        const sInvoiceKey = `${pFixture.origin}|${pPayload.ROLE_ID}|INVOICE`;
        oState.response.data = {...structuredClone(pPayload), RECORD_TYPE: 'invoice', CUSTOM_FORM_ID: '31'};
        oClock.now += 1000;
        oMarks = await reopenPopup();
        check(
            'No form scripts (miss): formScripts cached as [] (valid empty, not null)',
            Array.isArray(oSession[sInvoiceKey]?.formScripts) && oSession[sInvoiceKey].formScripts.length === 0,
            JSON.stringify(oSession[sInvoiceKey]?.formScripts)
        );

        oClock.now += 5000;
        oMarks = await reopenPopup();
        checkEqual('No form scripts (hit): light payload', oLog.replies.slice(oMarks.replies), ['light']);
        checkEqual('No form scripts (hit): zero scriptedrecord.nl fetches', fetchKindsSince(oMarks.fetches), []);
        check(
            'No form scripts (hit): scripts render, no Form Scripts group',
            document.querySelectorAll('#scriptCards .sm-deploy-id').length === pPayload.SCRIPTS_DATA.length &&
                !getSections().some((pSection) => pSection.title === 'Form Scripts'),
            getSections().map((pSection) => pSection.title).join(', ')
        );

        /* 11. Refresh lands while the previous request is writing the cache entry (review MN-001) */
        const sMarker = 'Superseded Request Marker WF';

        Object.keys(oSession).forEach((pKey) => {

            delete oSession[pKey];
        });
        oState.response.data = structuredClone(pPayload);
        oState.response.data.WORKFLOWS_DATA.push({
            WORKFLOW: '698', WORKFLOW_NAME: sMarker, DESCRIPTION: '', STATUS: 'Released', INACTIVE: false,
            STATE: 'active', URL: `${pFixture.origin}/app/common/workflow/setup/workflowmanager.nl?id=698`, EDIT_URL: ''
        });
        oState.deferSessionSet = true;
        oState.releaseSessionSet = null;

        document.body.replaceChildren();
        mountPopup(oState.popupHtml);
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await waitFor(() => !!oState.releaseSessionSet, 10000, 'held cache write');

        oState.response.data = structuredClone(pPayload);
        document.getElementById('refreshBtn').click();
        oState.releaseSessionSet();

        /* Well inside the 400 ms before the Refresh request's first poll */
        await delay(120);
        const oSpinner = document.getElementById('spinner');
        check(
            'Refresh during the cache write: the superseded request neither renders nor hides the spinner',
            !document.getElementById('scriptCards').textContent.includes(sMarker) &&
                getSections().length === 0 && !oSpinner.classList.contains('hidden'),
            `sections=${getSections().length} spinnerHidden=${oSpinner.classList.contains('hidden')}`
        );

        await waitFor(isRendered, 10000, 'refresh render after held write');
        await delay(100);
        check(
            'Refresh during the cache write: the Refresh result renders',
            snapshotView() === sFreshView && oSpinner.classList.contains('hidden'),
            'render differs'
        );

        oState.response.data = structuredClone(pPayload);
    };

    /**
     * no-session: chrome.storage.session missing -> no cache, every open is a full run.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     */
    const runNoSessionChecks = async (pFixture, pPayload) => {

        check(
            'No storage.session: first open sends no keys and fetches both pages',
            oLog.injects[0]?.cacheKeys.length === 0 && fetchKindsSince(0).join() === 'forms,stack',
            JSON.stringify(oLog.injects)
        );
        checkItems(pFixture, pPayload, false, undefined, 'no session');

        oClock.now += 5000;
        const oMarks = await reopenPopup();
        check(
            'No storage.session: reopen runs fully again (no keys, full payload, both pages)',
            oLog.injects[oMarks.injects]?.cacheKeys.length === 0 && oLog.replies[oMarks.replies] === 'full' &&
                fetchKindsSince(oMarks.fetches).join() === 'forms,stack',
            JSON.stringify(oLog.injects.slice(oMarks.injects))
        );
        checkEqual('No storage.session: Refresh tooltip', document.getElementById('refreshBtn').title, 'Refresh data');
    };

    /**
     * slow-forms: the forms request never answers; the popup timeout must abort it and render
     * scripts and workflows without a Form Scripts group or an error.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     */
    const runSlowFormsChecks = (pFixture, pPayload) => {

        const oFormsFetch = oLog.fetches.find((pFetch) => pFetch.kind === 'forms');
        const oAbort = oLog.aborted.find((pAbort) => pAbort.kind === 'forms');
        const nWaitMs = oFormsFetch && oAbort ? oAbort.at - oFormsFetch.at : -1;

        check(
            'Stalled forms request aborted by the popup timeout (~5 s)',
            !!oFormsFetch && oFormsFetch.signal && !!oAbort && nWaitMs >= 4500,
            `signal=${oFormsFetch?.signal} aborted=${!!oAbort} after ${nWaitMs.toFixed(0)} ms`
        );

        const aStack = oLog.fetches.filter((pFetch) => pFetch.kind === 'stack');
        check(
            'Stack order page fetched normally (credentials include, AbortSignal)',
            aStack.length === 1 && aStack[0].credentials === 'include' && aStack[0].signal,
            JSON.stringify(aStack)
        );

        checkItems(pFixture, pPayload, false, []);
        checkStackOrder(pFixture);

        const oMessage = document.getElementById('message');
        check(
            'No error shown after the timeout',
            !oMessage.classList.contains('error') && !document.querySelector('#scriptCards .sm-error-row'),
            `message class="${oMessage.className}" text="${oMessage.textContent}"`
        );
        check(
            'Spinner hidden after the timeout',
            document.getElementById('spinner').classList.contains('hidden'),
            'visible'
        );
    };

    /**
     * deployed-filter: Deployed pill on (stored), legacy stored group order, then unknown form.
     *
     * @param {Object} pFixture
     * @param {Object} pPayload
     */
    const runDeployedFilterChecks = async (pFixture, pPayload) => {

        check(
            'Deployed pill restored as active',
            document.getElementById('deployedToggle').classList.contains('active'),
            'not active'
        );

        checkItems(pFixture, pPayload, true);

        const oInactiveWorkflow = pPayload.WORKFLOWS_DATA.find((pWorkflow) => pWorkflow.STATE === 'inactive');
        check(
            'Inactive workflow with Released status hidden by the Deployed filter',
            !!oInactiveWorkflow && oInactiveWorkflow.STATUS === 'Released' &&
                !findNamedCard('Workflows', oInactiveWorkflow.WORKFLOW_NAME),
            'still rendered or not in fixture'
        );

        const aTesting = [
            ...pPayload.SCRIPTS_DATA.filter((pScript) => pScript.STATE === 'testing')
                .map((pScript) => findScriptCard(pScript.DEPLOYMENT_URL)),
            ...pPayload.WORKFLOWS_DATA.filter((pWorkflow) => pWorkflow.STATE === 'testing')
                .map((pWorkflow) => findNamedCard('Workflows', pWorkflow.WORKFLOW_NAME))
        ];
        check(
            'Testing scripts and workflows stay visible with the Deployed filter',
            aTesting.length >= 2 && aTesting.every((pCard) => !!pCard),
            `${aTesting.filter((pCard) => !!pCard).length}/${aTesting.length} visible`
        );

        const oFirstSet = oLog.storageSets.find((pItems) => 'groupOrder' in pItems);
        check(
            'Stored group order: "Custom GL Lines (Plug-in)" stripped and persisted on load',
            !!oFirstSet && !oFirstSet.groupOrder.includes('Custom GL Lines (Plug-in)'),
            JSON.stringify(oFirstSet)
        );

        const aStored = oStore.groupOrder || [];
        const nFormsIdx = aStored.indexOf('Form Scripts');
        check(
            'Stored group order gains "Form Scripts" before Workflows',
            !aStored.includes('Custom GL Lines (Plug-in)') && nFormsIdx !== -1 &&
                nFormsIdx < aStored.indexOf('Workflows'),
            JSON.stringify(aStored)
        );

        check(
            'Settings drawer has no "Custom GL Lines (Plug-in)"',
            !readDrawerGroups().includes('Custom GL Lines (Plug-in)'),
            'present'
        );

        /* Phase 2: unknown form -- form scripts may run, so the filter keeps them */
        oState.response.data.CUSTOM_FORM_ID = '';
        document.getElementById('refreshBtn').click();
        await waitFor(isRendered, 10000, 'refresh render');
        await delay(100);

        checkItems(pFixture, oState.response.data, true);
    };

    /**
     * Runs the selected scenario.
     */
    const run = async () => {

        if (!SCENARIOS.includes(sScenario)) {
            throw new Error(`Unknown scenario "${sScenario}". Use one of: ${SCENARIOS.join(', ')}`);
        }

        if (document.readyState === 'loading') {
            await new Promise((pResolve) => document.addEventListener('DOMContentLoaded', pResolve, {once: true}));
        }

        const oFixtureUrl = new URL(sFixtureUrl, document.baseURI);
        const oFixture = await (await fnNativeFetch(oFixtureUrl)).json();

        /**
         * Fetches a text resource or throws.
         *
         * @param {URL|string} pUrl
         * @returns {Promise<string>}
         */
        const fetchText = async (pUrl) => {

            const oResponse = await fnNativeFetch(pUrl);

            if (!oResponse.ok) {
                throw new Error(`${pUrl}: HTTP ${oResponse.status}`);
            }

            return oResponse.text();
        };

        const [sFormsHtml, sStackHtml, sPopupHtml, sManifest, sFormsEmptyHtml] = await Promise.all([
            fetchText(new URL(oFixture.formsHtml, oFixtureUrl)),
            fetchText(new URL(oFixture.stackHtml, oFixtureUrl)),
            fetchText('popup.html'),
            fetchText('manifest.json'),
            oFixture.formsEmptyHtml ? fetchText(new URL(oFixture.formsEmptyHtml, oFixtureUrl)) : ''
        ]);

        oState.popupHtml = sPopupHtml;

        if (sFormsEmptyHtml) {
            oState.formsHtmlByType.INVOICE = sFormsEmptyHtml;
        }

        const oPayload = structuredClone(oFixture.payload);
        let sTabPath = oFixture.recordPath;
        oState.response = {type: 'SCRIPTS_DATA', error: null, data: oPayload};

        if (sScenario === 'unknown-form') {
            oPayload.CUSTOM_FORM_ID = '';
        } else if (sScenario === 'forms-only') {
            oPayload.SCRIPTS_DATA = [];
            oPayload.WORKFLOWS_DATA = [];
        } else if (sScenario === 'create-mode') {
            sTabPath = oFixture.createPath;
        } else if (sScenario === 'no-record') {
            sTabPath = oFixture.noRecordPath;
            oState.response = {
                type: 'SCRIPTS_DATA',
                error: 'NO_RECORD',
                message: 'Unable to detect the record type on this page.'
            };
        } else if (sScenario === 'no-api') {
            sTabPath = oFixture.noApiPath || oFixture.noRecordPath;
            oState.response = {
                type: 'SCRIPTS_DATA',
                error: 'NO_API_AVAILABLE',
                message: 'Neither SuiteScript 2.x (require) nor SuiteScript 1.0 (nlapi) is available on this page.'
            };
        } else if (sScenario === 'deployed-filter') {
            oStore.deployedOnly = true;
            oStore.groupOrder = [...LEGACY_GROUP_ORDER];
        } else if (sScenario === 'slow-forms') {
            oState.stallForms = true;
        } else if (sScenario === 'count-warnings') {
            oState.response.data = buildWarningPayload(oFixture, WARNING_PHASES[0]);
        } else if (sScenario === 'slow-reply') {
            oState.replyDelayMs = 5000;
        } else if (sScenario === 'refresh-during-read') {
            oState.deferSessionGet = true;
        }

        oState.tabUrl = sScenario === 'non-netsuite' ? NON_NETSUITE_URL : oFixture.origin + sTabPath;

        /* Test-only clock read by popup.js getNow(); set before popup.js loads */
        window.__NS_SM_TEST_NOW__ = () => oClock.now;

        installChrome(JSON.parse(sManifest), sScenario !== 'no-session');
        installFetch(sFormsHtml, sStackHtml);
        mountPopup(sPopupHtml);
        await startPopup(sScenario !== 'refresh-during-read');

        if (sScenario === 'refresh-during-read') {

            /* Initial open is held in its storage.session read; Refresh starts meanwhile */
            await waitFor(() => !!oState.releaseSessionGet, 5000, 'held cache read');
            document.getElementById('refreshBtn').click();
            oState.releaseSessionGet();

            await waitFor(isRendered, 12000, 'render after refresh');

            /* Room for a late message from the superseded open */
            await delay(1500);
        }

        const oMessage = document.getElementById('message');
        const oCards = document.getElementById('scriptCards');

        if (sScenario === 'non-netsuite') {

            check(
                'Non-NetSuite tab: "Navigate to a NetSuite page" message, no injection',
                oMessage.classList.contains('visible') && oMessage.textContent === NON_NETSUITE_TEXT &&
                    oLog.injects.length === 0,
                `text="${oMessage.textContent}" injects=${oLog.injects.length}`
            );
            await checkFooterLink('Non-NetSuite tab');
        } else if (sScenario === 'no-record' || sScenario === 'no-api') {

            const sPrefix = oState.response.error;

            check(
                `${sPrefix}: friendly message shown without the error class`,
                oMessage.classList.contains('visible') && oMessage.textContent === NO_RECORD_TEXT &&
                    !oMessage.classList.contains('error'),
                `text="${oMessage.textContent}" class="${oMessage.className}"`
            );
            check(`${sPrefix}: no cards rendered`, oCards.children.length === 0, 'cards rendered');
            check(`${sPrefix}: scriptedrecord.nl not fetched`, oLog.fetches.length === 0, JSON.stringify(oLog.fetches));
            check(
                `${sPrefix}: Scripted Records button stays disabled`,
                document.getElementById('scriptedRecordsBtn').disabled,
                'enabled'
            );
        } else {

            check(
                'Message area hidden when data renders',
                !oMessage.classList.contains('visible'),
                oMessage.textContent
            );

            if (sScenario === 'record') {
                runRecordChecks(oFixture, oPayload);
                await runExclusivityChecks();
                await runPendingOpenChecks();
                await checkFooterLink('Record');
            } else if (sScenario === 'unknown-form') {
                checkItems(oFixture, oPayload, false);
            } else if (sScenario === 'forms-only') {
                checkFetches(oPayload, false);
                checkEqual(
                    'Forms only: the Form Scripts group is the only group',
                    getSections().map((pSection) => pSection.title),
                    ['Form Scripts']
                );
                checkItems(oFixture, oPayload, false);
            } else if (sScenario === 'create-mode') {
                const nScriptCards = oCards.querySelectorAll('.sm-deploy-id').length;

                check(
                    'Create mode: tab URL has no id parameter',
                    !new URL(oState.tabUrl).searchParams.has('id'),
                    oState.tabUrl
                );
                check(
                    'Create mode: injection requested',
                    oLog.runtimeMessages.includes('INJECT_AND_GET_DATA'),
                    oLog.runtimeMessages.join(',')
                );
                check(
                    'Create mode: scripts listed',
                    nScriptCards === oPayload.SCRIPTS_DATA.length,
                    `${nScriptCards} script cards`
                );
                checkItems(oFixture, oPayload, false);
            } else if (sScenario === 'deployed-filter') {
                await runDeployedFilterChecks(oFixture, oPayload);
            } else if (sScenario === 'slow-forms') {
                runSlowFormsChecks(oFixture, oPayload);
            } else if (sScenario === 'count-warnings') {
                await runCountWarningChecks(oFixture);
            } else if (sScenario === 'cache') {
                await runCacheChecks(oFixture, oPayload);
            } else if (sScenario === 'no-session') {
                await runNoSessionChecks(oFixture, oPayload);
            } else if (sScenario === 'slow-reply') {
                const nReplyMs = oLog.firstReplyAt - oLog.injectAt;

                check(
                    'Slow nsmain reply (~5 s): the popup kept polling and rendered it (no timeout)',
                    nReplyMs >= 4900 && oLog.polls >= 12 && !oMessage.classList.contains('error'),
                    `reply after ${nReplyMs.toFixed(0)} ms, ${oLog.polls} polls, message="${oMessage.textContent}"`
                );
                checkItems(oFixture, oPayload, false, undefined, 'slow reply');
            } else if (sScenario === 'refresh-during-read') {
                check(
                    'Refresh during the initial cache read: only the Refresh request id reaches the background',
                    oLog.injects.length === 1 && oLog.injects[0].cacheKeys.length === 0,
                    JSON.stringify(oLog.injects)
                );
                check(
                    'Refresh during the initial cache read: no timeout or error message',
                    !oMessage.classList.contains('visible') && !oMessage.classList.contains('error'),
                    `message="${oMessage.textContent}" class="${oMessage.className}"`
                );
                checkItems(oFixture, oPayload, false, undefined, 'refresh during cache read');
            }
        }

        check('No uncaught page errors', aPageErrors.length === 0, aPageErrors.join(' | '));
        check(
            'No CSP violations (securitypolicyviolation) while parsing NetSuite pages',
            aCspViolations.length === 0,
            `${aCspViolations.length} violation(s): ${aCspViolations.slice(0, 5).join(' | ')}`
        );
    };

    /**
     * Prints the results into the page and the console.
     */
    const renderResults = () => {

        const oPanel = document.createElement('section');
        oPanel.id = 'harness-results';

        const oTitle = document.createElement('h1');
        oTitle.className = oHarness.failed ? 'fail' : 'pass';
        oTitle.textContent = `${oHarness.failed ? 'FAIL' : 'PASS'} - scenario "${sScenario}": ` +
            `${oHarness.passed} passed, ${oHarness.failed} failed`;
        oPanel.appendChild(oTitle);

        const oNav = document.createElement('nav');

        SCENARIOS.forEach((pScenario) => {

            const oParamsCopy = new URLSearchParams(window.location.search);
            oParamsCopy.set('scenario', pScenario);

            const oLink = document.createElement('a');
            oLink.href = '?' + oParamsCopy.toString();
            oLink.textContent = pScenario;
            oNav.appendChild(oLink);
        });

        oPanel.appendChild(oNav);

        const oList = document.createElement('ol');

        oHarness.results.forEach((pResult) => {

            const oItem = document.createElement('li');
            oItem.className = pResult.pass ? 'pass' : 'fail';
            oItem.textContent = `${pResult.pass ? 'PASS' : 'FAIL'} ${pResult.name}` +
                (pResult.pass ? '' : ` -- ${pResult.detail}`);
            oList.appendChild(oItem);
        });

        oPanel.appendChild(oList);
        document.documentElement.appendChild(oPanel);
        const sVerdict = oHarness.failed ? 'FAIL' : 'PASS';
        document.title = `${sVerdict} ${sScenario} (${oHarness.passed}/${oHarness.results.length})`;

        console.log('[harness]', JSON.stringify({
            scenario: sScenario,
            passed: oHarness.passed,
            failed: oHarness.failed,
            failures: oHarness.results.filter((pResult) => !pResult.pass)
        }));
    };

    run().catch((pErr) => {

        check('Harness run', false, pErr && pErr.stack ? pErr.stack : String(pErr));
    }).finally(() => {

        oHarness.done = true;
        renderResults();
    });
})();
