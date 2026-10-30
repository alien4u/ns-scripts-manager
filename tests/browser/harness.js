/**
 * Popup harness -- renders the real popup.html body, css/main.css and js/popup.js against a
 * fake `chrome` API and stubbed scriptedrecord.nl responses, then asserts the DOM.
 *
 * Query params:
 *   ?scenario=record | unknown-form | forms-only | create-mode | no-record | no-api | deployed-filter | slow-forms
 *             | count-warnings
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
        'count-warnings'
    ];
    const NO_RECORD_TEXT = 'Open a NetSuite record to view its scripts.';
    const FORM_TITLE = 'Runs only on records that use this form';
    const DEFAULT_GROUP_ORDER = ['Client', 'Form Scripts', 'User Event', 'Workflows', 'Workflow Action', 'Mass Update'];
    const LEGACY_GROUP_ORDER = [
        'User Event', 'Client', 'Mass Update', 'Workflow Action', 'Custom GL Lines (Plug-in)', 'Workflows'
    ];
    const RUN_STATES = ['active', 'testing', 'current_form', 'unknown_form'];
    const MIN_CONTRAST = 4.5;

    const oParams = new URLSearchParams(window.location.search);
    const sScenario = oParams.get('scenario') || 'record';
    const sFixtureUrl = oParams.get('fixture') || 'tests/browser/fixtures/record.json';

    const oHarness = {done: false, scenario: sScenario, fixture: sFixtureUrl, passed: 0, failed: 0, results: []};
    window.__HARNESS__ = oHarness;

    const fnNativeFetch = window.fetch.bind(window);
    const aPageErrors = [];
    const aCspViolations = [];
    const oLog = {fetches: [], aborted: [], maxInFlight: 0, runtimeMessages: [], storageSets: [], tabsCreated: []};
    const oStore = {};
    const oState = {response: null, tabUrl: '', stallForms: false};

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
     * Installs the fake extension API used by popup.js.
     *
     * @param {Object} pManifest
     */
    const installChrome = (pManifest) => {

        const oFakeChrome = {
            runtime: {
                lastError: undefined,
                getManifest: () => pManifest,
                sendMessage: async (pMessage) => {

                    oLog.runtimeMessages.push(pMessage.type);
                    return {success: true};
                }
            },
            storage: {
                local: {
                    get: async (pKeys) => {

                        const aKeys = pKeys == null ? Object.keys(oStore) : [].concat(pKeys);
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
                }
            },
            tabs: {
                query: async () => [{id: 1, url: oState.tabUrl}],
                sendMessage: (pTabId, pMessage, pCallback) => {

                    const oReply = pMessage.type === 'GET_SCRIPTS_DATA' ? structuredClone(oState.response) : null;

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

            return new Response(bForms ? pFormsHtml : pStackHtml, {
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
     */
    const startPopup = async () => {

        await new Promise((pResolve, pReject) => {

            const oScript = document.createElement('script');
            oScript.src = 'js/popup.js';
            oScript.onload = pResolve;
            oScript.onerror = () => pReject(new Error('js/popup.js failed to load'));
            document.head.appendChild(oScript);
        });

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await waitFor(isRendered, 10000, 'popup render');
        await delay(100);
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
     */
    const checkItems = (pFixture, pPayload, pDeployedOnly, pFormScripts = pFixture.expect.formScripts) => {

        const sSuffix = pDeployedOnly ? ' [Deployed filter]' : '';

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

        const [sFormsHtml, sStackHtml, sPopupHtml, sManifest] = await Promise.all([
            fetchText(new URL(oFixture.formsHtml, oFixtureUrl)),
            fetchText(new URL(oFixture.stackHtml, oFixtureUrl)),
            fetchText('popup.html'),
            fetchText('manifest.json')
        ]);

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
        }

        oState.tabUrl = oFixture.origin + sTabPath;

        installChrome(JSON.parse(sManifest));
        installFetch(sFormsHtml, sStackHtml);
        mountPopup(sPopupHtml);
        await startPopup();

        const oMessage = document.getElementById('message');
        const oCards = document.getElementById('scriptCards');

        if (sScenario === 'no-record' || sScenario === 'no-api') {

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
