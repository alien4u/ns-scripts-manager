/**
 * Popup Script — NetSuite Scripts Manager
 *
 * Handles the extension popup UI, including:
 * - Fetching data from the content script
 * - Rendering script and workflow cards
 * - Managing settings (dark mode, compact mode, sorting, grouping)
 */

document.addEventListener('DOMContentLoaded', () => {

    runPopupLogic();
});

/**
 * Main logic for the popup.
 */
const runPopupLogic = async () => {

    if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
        window.chrome = browser;
    }

    const oFooterVersion = document.getElementById('footerVersion');
    if (oFooterVersion) {
        oFooterVersion.textContent = 'NetSuite Scripts Manager v' + chrome.runtime.getManifest().version;
    }

    /* ────────────────────────────────────────────────
     * DOM References
     * ──────────────────────────────────────────────── */

    const oSpinner = document.getElementById('spinner');
    const oCardsContainer = document.getElementById('scriptCards');
    const oMessage = document.getElementById('message');

    /* Pill toggle references */
    const oCompactToggle = document.getElementById('compactToggle');
    const oDarkToggle = document.getElementById('darkToggle');
    const oDeployedToggle = document.getElementById('deployedToggle');

    /* Sort select reference */
    const oSortSelect = document.getElementById('sortSelect');

    /* Refresh button */
    const oRefreshBtn = document.getElementById('refreshBtn');

    /* Scripted Records button */
    const oScriptedRecordsBtn = document.getElementById('scriptedRecordsBtn');

    /* Scheduler panel references */
    const oSchedulerBtn = document.getElementById('schedulerBtn');
    const oSchedulerPanel = document.getElementById('schedulerPanel');

    const oSchedulerEnv = document.getElementById('schedulerEnv');
    const oSchedulerCollectBtn = document.getElementById('schedulerCollectBtn');
    const oSchedulerCheckBtn = document.getElementById('schedulerCheckBtn');
    const oSchedulerApplyBtn = document.getElementById('schedulerApplyBtn');
    const oSchedulerClearBtn = document.getElementById('schedulerClearBtn');
    const oSchedulerStatus = document.getElementById('schedulerStatus');
    const oSchedulerListHeader = document.getElementById('schedulerListHeader');
    const oSchedulerSelectAll = document.getElementById('schedulerSelectAll');
    const oSchedulerSelectedCount = document.getElementById('schedulerSelectedCount');
    const oSchedulerList = document.getElementById('schedulerList');
    const oSchedulerLogBtn = document.getElementById('schedulerLogBtn');

    const oSchedulerWarning = document.getElementById('schedulerWarning');

    let aApplyErrors = [];

    /* Settings drawer references */
    const oSettingsBtn = document.getElementById('settingsBtn');
    const oSettingsDrawer = document.getElementById('settingsDrawer');

    const oGroupOrderList = document.getElementById('groupOrderList');

    let bMinDisplayElapsed = false;

    /* ────────────────────────────────────────────────
     * Default Group Order
     * ──────────────────────────────────────────────── */

    const DEFAULT_GROUP_ORDER = [
        'User Event',
        'Client',
        'Mass Update',
        'Workflow Action',
        'Custom GL Lines (Plug-in)',
        'Workflows'
    ];

    /** Current group order (loaded from storage or default) */
    let aGroupOrder = [...DEFAULT_GROUP_ORDER];

    /* ────────────────────────────────────────────────
     * SVG Icon Helper
     * ──────────────────────────────────────────────── */

    /**
     * Creates an inline SVG element referencing the sprite.
     *
     * @param {string} pIconId - The symbol ID (e.g. 'ico-edit')
     * @param {string} [pExtraClass] - Optional additional CSS class
     * @returns {SVGSVGElement}
     */
    const createSvgIcon = (pIconId, pExtraClass) => {

        const oSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        oSvg.classList.add('sm-icon');

        if (pExtraClass) {
            oSvg.classList.add(pExtraClass);
        }

        const oUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        oUse.setAttribute('href', '#' + pIconId);
        oSvg.appendChild(oUse);

        return oSvg;
    };

    /* ────────────────────────────────────────────────
     * Utility Functions
     * ──────────────────────────────────────────────── */

    /**
     * Hides the spinner element.
     */
    const hideSpinner = () => {

        if (!bMinDisplayElapsed) {
            return;
        }

        oSpinner.classList.add('hidden');
    };

    /**
     * Shows a message to the user.
     *
     * @param {string} pMessage
     * @param {boolean} pIsError
     */
    const showMessage = (pMessage, pIsError) => {

        oSpinner.classList.add('hidden');
        oMessage.textContent = pMessage;
        oMessage.classList.add('visible');
        oMessage.classList.remove('error');

        if (pIsError) {
            oMessage.classList.add('error');
        }

        bMinDisplayElapsed = true;
        hideSpinner();
    };

    /**
     * Resets the UI to the loading state.
     */
    const resetSpinner = () => {

        oCardsContainer.replaceChildren();
        oMessage.classList.remove('visible', 'error');
        oSpinner.classList.remove('hidden');
        bMinDisplayElapsed = false;
        bStackOrderAvailable = false;
    };

    /* ────────────────────────────────────────────────
     * Restore Settings from Storage
     * ──────────────────────────────────────────────── */

    const oStoredSettings = await chrome.storage.local.get(
        ['compactMode', 'darkMode', 'deployedOnly', 'sortOrder', 'groupOrder', 'sm_popupWidth', 'sm_popupHeight']
    ).catch(() => ({}));

    if (oStoredSettings.compactMode) {
        document.body.classList.add('sm-compact');
        if (oCompactToggle) {
            oCompactToggle.classList.add('active');
        }
    }

    if (oStoredSettings.darkMode) {
        document.body.classList.add('theme-dark');
        if (oDarkToggle) {
            oDarkToggle.classList.add('active');
        }
    }

    if (oStoredSettings.deployedOnly) {
        if (oDeployedToggle) {
            oDeployedToggle.classList.add('active');
        }
    }

    if (oStoredSettings.sortOrder && oSortSelect) {
        oSortSelect.value = oStoredSettings.sortOrder === 'default' ? 'stack' : oStoredSettings.sortOrder;
    }

    if (oStoredSettings.groupOrder && Array.isArray(oStoredSettings.groupOrder)) {
        aGroupOrder = oStoredSettings.groupOrder;
    }

    /* ────────────────────────────────────────────────
     * Popup Resize
     * ──────────────────────────────────────────────── */

    const nMinWidth = 400;
    const nMaxWidth = 900;
    const nMinHeight = 300;
    const nMaxHeight = 600;

    const oRoot = document.documentElement;

    /**
     * Sets the popup dimensions on both html and body elements.
     *
     * @param {number} pWidth
     * @param {number} pHeight
     */
    const setPopupSize = (pWidth, pHeight) => {
        const sW = pWidth + 'px';
        const sH = pHeight + 'px';
        oRoot.style.setProperty('--sm-width', sW);
        oRoot.style.width = sW;
        oRoot.style.maxWidth = sW;
        oRoot.style.height = sH;
        document.body.style.width = sW;
        document.body.style.maxWidth = sW;
    };

    const nDefaultWidth = 420;
    const nDefaultHeight = 500;
    setPopupSize(
        oStoredSettings.sm_popupWidth || nDefaultWidth,
        oStoredSettings.sm_popupHeight || nDefaultHeight
    );

    const oResizeHandle = document.getElementById('resizeHandle');
    if (oResizeHandle) {

        let bDragging = false;
        let nStartX, nStartY, nStartW, nStartH;

        oResizeHandle.addEventListener('mousedown', (pEvent) => {
            pEvent.preventDefault();
            bDragging = true;
            nStartX = pEvent.screenX;
            nStartY = pEvent.screenY;
            nStartW = oRoot.offsetWidth;
            nStartH = oRoot.offsetHeight;
            document.body.classList.add('sm-resizing');
            oResizeHandle.classList.add('dragging');
        });

        document.addEventListener('mousemove', (pEvent) => {
            if (!bDragging) return;
            const nNewW = Math.min(Math.max(nStartW - (pEvent.screenX - nStartX), nMinWidth), nMaxWidth);
            const nNewH = Math.min(Math.max(nStartH + (pEvent.screenY - nStartY), nMinHeight), nMaxHeight);
            setPopupSize(nNewW, nNewH);
        });

        document.addEventListener('mouseup', () => {
            if (!bDragging) return;
            bDragging = false;
            document.body.classList.remove('sm-resizing');
            oResizeHandle.classList.remove('dragging');
            chrome.storage.local.set({
                sm_popupWidth: oRoot.offsetWidth,
                sm_popupHeight: oRoot.offsetHeight
            }).catch(() => {});
        });
    }

    /* ────────────────────────────────────────────────
     * In-memory data for re-rendering on toggle/sort/order changes
     * ──────────────────────────────────────────────── */

    let oLastData = null;
    let bStackOrderAvailable = false;

    /* ────────────────────────────────────────────────
     * Stack Order — Scripted Record Page Scraper
     * ──────────────────────────────────────────────── */

    /**
     * Fetches the scripted record page and parses the execution
     * order (row position per layer). Returns a Map of script
     * internal ID to its zero-based stack position.
     *
     * @param {string} pOrigin - NetSuite origin URL
     * @param {string} pRecordType - Record type ID
     * @returns {Promise<Map<string, number>>}
     */
    const fetchStackOrder = async (pOrigin, pRecordType) => {

        const sUrl = `${pOrigin}/app/common/scripting/scriptedrecord.nl?id=${pRecordType.toUpperCase()}`;

        const oResponse = await fetch(sUrl, {credentials: 'include'});

        if (!oResponse.ok) {
            return new Map();
        }

        const sHtml = await oResponse.text();
        const oParser = new DOMParser();
        const oDoc = oParser.parseFromString(sHtml, 'text/html');

        const oStackMap = new Map();
        let nOrder = 0;

        const aLayers = ['server', 'client', 'serverlocalized', 'clientlocalized'];

        aLayers.forEach((pLayer) => {

            const oContainer = oDoc.querySelector(
                `[data-nsps-layer="${pLayer}"] .uir-machine-table-container`
            );

            if (!oContainer) {
                return;
            }

            const aLinks = oContainer.querySelectorAll('a[href*="script.nl?id="]');

            aLinks.forEach((pLink) => {

                const oMatch = pLink.href.match(/script\.nl\?id=(\d+)/);

                if (oMatch) {
                    const sScriptId = oMatch[1];

                    if (!oStackMap.has(sScriptId)) {
                        oStackMap.set(sScriptId, nOrder++);
                    }
                }
            });
        });

        return oStackMap;
    };

    /**
     * Applies stack order indexes to script data.
     *
     * @param {Array} pScriptsData
     * @param {Map<string, number>} pStackMap
     */
    const applyStackOrder = (pScriptsData, pStackMap) => {

        const nFallback = pStackMap.size;

        pScriptsData.forEach((pScript) => {

            const sScriptId = String(pScript.SCRIPT);
            pScript.STACK_ORDER = pStackMap.has(sScriptId)
                ? pStackMap.get(sScriptId)
                : nFallback;
        });
    };

    /* ────────────────────────────────────────────────
     * Rendering Functions
     * ──────────────────────────────────────────────── */

    /**
     * Determines if a script deployment is actively running.
     *
     * @param {Object} pScript
     * @returns {boolean}
     */
    const isScriptActive = (pScript) => {

        return pScript.DEPLOYED && !pScript.INACTIVE;
    };

    /**
     * Creates a single script card element.
     *
     * @param {Object} pScript
     * @returns {HTMLDivElement}
     */
    const createScriptCard = (pScript) => {

        const oCard = document.createElement('div');
        oCard.className = 'script-card';

        if (!isScriptActive(pScript)) {
            oCard.classList.add('inactive');
        }

        /* ── Top Row: Name + Actions ── */
        const oTop = document.createElement('div');
        oTop.className = 'card-top';

        /* Card Name */
        const oName = document.createElement('div');
        oName.className = 'card-name';

        const oNameLink = document.createElement('a');
        oNameLink.href = pScript.URL;
        oNameLink.target = '_blank';
        oNameLink.textContent = pScript.SCRIPT_NAME;
        oName.appendChild(oNameLink);

        if (pScript.HIDE_IN_BUNDLE) {
            oName.appendChild(createSvgIcon('ico-lock', 'sm-lock-icon'));
        }

        oTop.appendChild(oName);

        /* Card Actions */
        const oActions = document.createElement('div');
        oActions.className = 'card-actions';

        if (pScript.HIDE_IN_BUNDLE) {

            const oEditDisabled = document.createElement('span');
            oEditDisabled.className = 'card-action-btn disabled';
            oEditDisabled.title = 'Edit (locked)';
            oEditDisabled.appendChild(createSvgIcon('ico-edit'));
            oActions.appendChild(oEditDisabled);

            const oSourceDisabled = document.createElement('span');
            oSourceDisabled.className = 'card-action-btn disabled';
            oSourceDisabled.title = 'Source (locked)';
            oSourceDisabled.appendChild(createSvgIcon('ico-code'));
            oActions.appendChild(oSourceDisabled);

        } else {

            const oEditLink = document.createElement('a');
            oEditLink.className = 'card-action-btn';
            oEditLink.href = pScript.URL + '&e=T';
            oEditLink.target = '_blank';
            oEditLink.title = 'Edit';
            oEditLink.appendChild(createSvgIcon('ico-edit'));
            oActions.appendChild(oEditLink);

            const oSourceLink = document.createElement('a');
            oSourceLink.className = 'card-action-btn';
            oSourceLink.href = pScript.FILE_URL;
            oSourceLink.target = '_blank';
            oSourceLink.title = 'Edit Source';
            oSourceLink.appendChild(createSvgIcon('ico-code'));
            oActions.appendChild(oSourceLink);
        }

        /* Info button with tooltip */
        const oInfoBtn = document.createElement('span');
        oInfoBtn.className = 'card-action-btn';
        oInfoBtn.title = '';
        oInfoBtn.appendChild(createSvgIcon('ico-info'));

        const oTooltip = document.createElement('div');
        oTooltip.className = 'sm-tooltip';
        oTooltip.textContent = pScript.INFO || 'No Info';
        oInfoBtn.appendChild(oTooltip);

        oActions.appendChild(oInfoBtn);
        oTop.appendChild(oActions);
        oCard.appendChild(oTop);

        /* ── Meta Row: Status Badge + Deployed Dot ── */
        const oMeta = document.createElement('div');
        oMeta.className = 'card-meta';

        const oBadge = document.createElement('span');
        oBadge.className = 'sm-badge';
        oBadge.textContent = (pScript.STATUS || 'N/A').toLowerCase();

        if (isScriptActive(pScript)) {
            oBadge.classList.add('active');
        } else {
            oBadge.classList.add('inactive');
        }

        oMeta.appendChild(oBadge);

        if (isScriptActive(pScript)) {
            const oDot = document.createElement('span');
            oDot.className = 'sm-deployed-dot';
            oDot.title = 'Deployed';
            oMeta.appendChild(oDot);
        }

        oCard.appendChild(oMeta);

        /* ── Hooks Row: Entry Point Badges ── */
        const aHookDefs = [
            {key: 'BEFORE_LOAD_FN', label: 'beforeLoad'},
            {key: 'BEFORE_SUBMIT_FN', label: 'beforeSubmit'},
            {key: 'AFTER_SUBMIT_FN', label: 'afterSubmit'},
            {key: 'PAGE_INIT_FN', label: 'pageInit'},
            {key: 'FIELD_CHANGED_FN', label: 'fieldChanged'},
            {key: 'SAVE_RECORD_FN', label: 'saveRecord'},
            {key: 'VALIDATE_FIELD_FN', label: 'validateField'},
        ];

        const aActiveHooks = aHookDefs.filter((pDef) => pScript[pDef.key]);

        if (aActiveHooks.length > 0) {

            const oHooks = document.createElement('div');
            oHooks.className = 'card-hooks';

            aActiveHooks.forEach((pDef) => {

                const oTag = document.createElement('span');
                oTag.className = 'sm-hook-tag';
                oTag.textContent = pDef.label;
                oHooks.appendChild(oTag);
            });

            oCard.appendChild(oHooks);
        }

        return oCard;
    };

    /**
     * Creates a single workflow card element.
     *
     * @param {Object} pWorkflow
     * @returns {HTMLDivElement}
     */
    const createWorkflowCard = (pWorkflow) => {

        const oCard = document.createElement('div');
        oCard.className = 'script-card';

        /* ── Top Row: Name + Actions ── */
        const oTop = document.createElement('div');
        oTop.className = 'card-top';

        /* Card Name */
        const oName = document.createElement('div');
        oName.className = 'card-name';

        const oNameLink = document.createElement('a');
        oNameLink.href = pWorkflow.URL;
        oNameLink.target = '_blank';
        oNameLink.textContent = pWorkflow.WORKFLOW_NAME;
        oName.appendChild(oNameLink);

        oTop.appendChild(oName);

        /* Card Actions */
        const oActions = document.createElement('div');
        oActions.className = 'card-actions';

        const oEditLink = document.createElement('a');
        oEditLink.className = 'card-action-btn';
        oEditLink.href = pWorkflow.EDIT_URL;
        oEditLink.target = '_blank';
        oEditLink.title = 'Edit';
        oEditLink.appendChild(createSvgIcon('ico-edit'));
        oActions.appendChild(oEditLink);

        /* Info button with tooltip */
        const oInfoBtn = document.createElement('span');
        oInfoBtn.className = 'card-action-btn';
        oInfoBtn.title = '';
        oInfoBtn.appendChild(createSvgIcon('ico-info'));

        const oTooltip = document.createElement('div');
        oTooltip.className = 'sm-tooltip';
        oTooltip.textContent = 'Description: ' + (pWorkflow.DESCRIPTION || 'N/A');
        oInfoBtn.appendChild(oTooltip);

        oActions.appendChild(oInfoBtn);
        oTop.appendChild(oActions);
        oCard.appendChild(oTop);

        /* ── Meta Row ── */
        const oMeta = document.createElement('div');
        oMeta.className = 'card-meta';

        const oBadge = document.createElement('span');
        oBadge.className = 'sm-badge';
        oBadge.textContent = (pWorkflow.STATUS || 'N/A').toLowerCase();

        const bReleased = (pWorkflow.STATUS || '').toLowerCase() === 'released';

        if (bReleased) {
            oBadge.classList.add('active');
        } else {
            oBadge.classList.add('inactive');
        }

        oMeta.appendChild(oBadge);

        if (bReleased) {
            const oDot = document.createElement('span');
            oDot.className = 'sm-deployed-dot';
            oDot.title = 'Released';
            oMeta.appendChild(oDot);
        }

        oCard.appendChild(oMeta);

        return oCard;
    };

    /**
     * Renders a section (header + body of cards) for a script group.
     *
     * @param {DocumentFragment} pFragment
     * @param {string} pType
     * @param {Array} pScripts
     */
    const renderScriptSection = (pFragment, pType, pScripts) => {

        /* Section Header */
        const oHeader = document.createElement('div');
        oHeader.className = 'section-header';

        const oHeaderText = document.createElement('span');
        oHeaderText.className = 'section-header-text';
        oHeaderText.textContent = pType + ' Scripts';

        const oHeaderCount = document.createElement('span');
        oHeaderCount.className = 'section-header-count';
        oHeaderCount.textContent = '(' + pScripts.length + ')';

        oHeader.appendChild(oHeaderText);
        oHeader.appendChild(oHeaderCount);

        /* Count Warning Badge */
        const sTypeLower = pType.toLowerCase();
        const nCount = pScripts.length;
        const sClientDocsUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N3949604.html';
        const sUeDocsUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N3361453.html';

        if (sTypeLower === 'client' && nCount >= 8) {

            const oWarn = document.createElement('span');
            oWarn.className = 'sm-count-warn';

            let sTooltipText;

            if (nCount >= 10) {
                oWarn.classList.add('danger');
                oWarn.textContent = 'LIMIT';
                sTooltipText = 'By default, a maximum of 10 Client scripts can be deployed per record. Scripts beyond this limit will not execute.';
            } else {
                oWarn.classList.add('warn');
                oWarn.textContent = nCount;
                sTooltipText = 'Approaching the default limit of 10 Client scripts per record.';
            }

            const oTip = document.createElement('div');
            oTip.className = 'sm-warn-tooltip';

            const oTipText = document.createElement('span');
            oTipText.textContent = sTooltipText;
            oTip.appendChild(oTipText);

            const oTipLink = document.createElement('a');
            oTipLink.href = sClientDocsUrl;
            oTipLink.target = '_blank';
            oTipLink.textContent = 'Client Script Deployment Limit';
            oTipLink.addEventListener('click', (pEvent) => pEvent.stopPropagation());
            oTip.appendChild(oTipLink);

            oWarn.appendChild(oTip);
            oHeader.appendChild(oWarn);

        } else if (sTypeLower === 'user event' && nCount >= 10) {

            const oWarn = document.createElement('span');
            oWarn.className = 'sm-count-warn warn';
            oWarn.textContent = nCount;

            const oTip = document.createElement('div');
            oTip.className = 'sm-warn-tooltip';

            const oTipText = document.createElement('span');
            oTipText.textContent = 'Avoid assigning too many scripts to one record type. A high number of User Event scripts can increase load and save times.';
            oTip.appendChild(oTipText);

            const oTipLink = document.createElement('a');
            oTipLink.href = sUeDocsUrl;
            oTipLink.target = '_blank';
            oTipLink.textContent = 'User Event Script Best Practices';
            oTipLink.addEventListener('click', (pEvent) => pEvent.stopPropagation());
            oTip.appendChild(oTipLink);

            oWarn.appendChild(oTip);
            oHeader.appendChild(oWarn);
        }

        oHeader.appendChild(createSvgIcon('ico-chevron', 'sm-chevron'));

        /* Section Body */
        const oBody = document.createElement('div');
        oBody.className = 'section-body';

        pScripts.forEach((pScript) => {

            oBody.appendChild(createScriptCard(pScript));
        });

        /* Toggle collapse on header click */
        oHeader.addEventListener('click', () => {

            oHeader.classList.toggle('collapsed');
            oBody.classList.toggle('collapsed');
        });

        pFragment.appendChild(oHeader);
        pFragment.appendChild(oBody);
    };

    /**
     * Renders the workflow section.
     *
     * @param {DocumentFragment} pFragment
     * @param {Array} pWorkflows
     * @param {string} pSortOrder
     */
    const renderWorkflowSection = (pFragment, pWorkflows, pSortOrder) => {

        /* Sort workflows by name if needed */
        const aSorted = [...pWorkflows];

        if (pSortOrder === 'asc') {
            aSorted.sort((pA, pB) => (pA.WORKFLOW_NAME || '').localeCompare(pB.WORKFLOW_NAME || ''));
        } else if (pSortOrder === 'desc') {
            aSorted.sort((pA, pB) => (pB.WORKFLOW_NAME || '').localeCompare(pA.WORKFLOW_NAME || ''));
        }

        /* Section Header */
        const oHeader = document.createElement('div');
        oHeader.className = 'section-header';

        const oHeaderText = document.createElement('span');
        oHeaderText.className = 'section-header-text';
        oHeaderText.textContent = 'Workflows';

        const oHeaderCount = document.createElement('span');
        oHeaderCount.className = 'section-header-count';
        oHeaderCount.textContent = '(' + aSorted.length + ')';

        oHeader.appendChild(oHeaderText);
        oHeader.appendChild(oHeaderCount);
        oHeader.appendChild(createSvgIcon('ico-chevron', 'sm-chevron'));

        /* Section Body */
        const oBody = document.createElement('div');
        oBody.className = 'section-body';

        aSorted.forEach((pWorkflow) => {

            oBody.appendChild(createWorkflowCard(pWorkflow));
        });

        /* Toggle collapse on header click */
        oHeader.addEventListener('click', () => {

            oHeader.classList.toggle('collapsed');
            oBody.classList.toggle('collapsed');
        });

        pFragment.appendChild(oHeader);
        pFragment.appendChild(oBody);
    };

    /**
     * Returns an ordered array of group keys based on aGroupOrder.
     *
     * @param {string[]} pKeys
     * @returns {string[]}
     */
    const getOrderedGroupKeys = (pKeys) => {

        const aOrdered = [];
        const aRemaining = [...pKeys];

        /* Add keys in the saved order */
        aGroupOrder.forEach((pGroup) => {

            const nIdx = aRemaining.findIndex((pKey) =>
                pKey.toLowerCase() === pGroup.toLowerCase()
            );

            if (nIdx !== -1) {
                aOrdered.push(aRemaining.splice(nIdx, 1)[0]);
            }
        });

        /* Append any unknown groups alphabetically */
        aRemaining.sort((pA, pB) => pA.localeCompare(pB));
        aOrdered.push(...aRemaining);

        /* If there are new groups not in aGroupOrder, add them for future ordering */
        const aNewGroups = aRemaining.filter((pGroup) =>
            !aGroupOrder.some((pOrder) => pOrder.toLowerCase() === pGroup.toLowerCase())
        );

        if (aNewGroups.length > 0) {

            /* Insert before "Workflows" if it exists, otherwise append */
            const nWfIdx = aGroupOrder.findIndex((pGroup) => pGroup.toLowerCase() === 'workflows');

            if (nWfIdx !== -1) {
                aGroupOrder.splice(nWfIdx, 0, ...aNewGroups);
            } else {
                aGroupOrder.push(...aNewGroups);
            }

            chrome.storage.local.set({groupOrder: aGroupOrder}).catch(() => {});
        }

        return aOrdered;
    };

    /**
     * Sorts scripts within each group alphabetically by name.
     *
     * @param {Object} pGroupedScripts
     * @param {string} pSortOrder
     * @returns {Object}
     */
    const sortScriptsWithinGroups = (pGroupedScripts, pSortOrder) => {

        if (!pSortOrder) {
            return pGroupedScripts;
        }

        const oSorted = {};

        if (pSortOrder === 'stack') {

            if (!bStackOrderAvailable) {
                return pGroupedScripts;
            }

            Object.keys(pGroupedScripts).forEach((pKey) => {

                oSorted[pKey] = [...pGroupedScripts[pKey]].sort((pA, pB) => {
                    return (pA.STACK_ORDER ?? Number.MAX_SAFE_INTEGER) - (pB.STACK_ORDER ?? Number.MAX_SAFE_INTEGER);
                });
            });

            return oSorted;
        }

        const bAscending = pSortOrder === 'asc';

        Object.keys(pGroupedScripts).forEach((pKey) => {

            oSorted[pKey] = [...pGroupedScripts[pKey]].sort((pA, pB) => {

                const sNameA = (pA.SCRIPT_NAME || '').toLowerCase();
                const sNameB = (pB.SCRIPT_NAME || '').toLowerCase();

                return bAscending
                    ? sNameA.localeCompare(sNameB)
                    : sNameB.localeCompare(sNameA);
            });
        });

        return oSorted;
    };

    /**
     * Renders all data.
     *
     * @param {Array} pScriptsData
     * @param {Array} pWorkflowsData
     * @param {string} pScriptError
     * @param {string} pWorkflowError
     */
    const renderAll = (pScriptsData, pWorkflowsData, pScriptError, pWorkflowError) => {

        /* Filter for Deployed Only */
        const bShowOnlyDeployed = oDeployedToggle?.classList.contains('active');

        const aFilteredScripts = bShowOnlyDeployed
            ? pScriptsData.filter(isScriptActive)
            : pScriptsData;

        const aFilteredWorkflows = bShowOnlyDeployed
            ? pWorkflowsData.filter((pWorkflow) => {
                const sStatus = (pWorkflow.STATUS || '').toLowerCase();
                return sStatus === 'released';
            })
            : pWorkflowsData;

        /* Group scripts by type */
        let oGroupedScripts = aFilteredScripts.reduce((pAcc, pScriptObj) => {

            (pAcc[pScriptObj.SCRIPT_TYPE] = pAcc[pScriptObj.SCRIPT_TYPE] || []).push(pScriptObj);
            return pAcc;
        }, {});

        /* Apply name sort within groups */
        const sSortOrder = oSortSelect?.value || 'stack';
        oGroupedScripts = sortScriptsWithinGroups(oGroupedScripts, sSortOrder);

        /* Get all group keys (script types) */
        const aScriptGroupKeys = Object.keys(oGroupedScripts);

        /* Build combined key list: script groups + "Workflows" if present */
        const aAllKeys = [...aScriptGroupKeys];
        const bHasWorkflows = aFilteredWorkflows && aFilteredWorkflows.length > 0;

        if (bHasWorkflows) {
            aAllKeys.push('Workflows');
        }

        /* Apply user-defined group order */
        const aOrderedKeys = getOrderedGroupKeys(aAllKeys);

        /* Render in order */
        const oFragment = document.createDocumentFragment();
        let bRenderedAnything = false;

        aOrderedKeys.forEach((pKey) => {

            if (pKey === 'Workflows') {
                if (bHasWorkflows) {
                    renderWorkflowSection(oFragment, aFilteredWorkflows, sSortOrder);
                    bRenderedAnything = true;
                }
            } else if (oGroupedScripts[pKey]) {
                renderScriptSection(oFragment, pKey, oGroupedScripts[pKey]);
                bRenderedAnything = true;
            }
        });

        /* Show script error if any */
        if (pScriptError) {
            const oErrRow = document.createElement('div');
            oErrRow.className = 'sm-error-row';
            const oStrong = document.createElement('strong');
            oStrong.textContent = 'Script Error:';
            oErrRow.appendChild(oStrong);
            oErrRow.appendChild(document.createTextNode(' ' + pScriptError));
            oFragment.appendChild(oErrRow);
        }

        /* Show workflow error if any */
        if (pWorkflowError) {
            const oErrRow = document.createElement('div');
            oErrRow.className = 'sm-error-row';
            const oStrong = document.createElement('strong');
            oStrong.textContent = 'Workflow Error:';
            oErrRow.appendChild(oStrong);
            oErrRow.appendChild(document.createTextNode(' ' + pWorkflowError));
            oFragment.appendChild(oErrRow);
        }

        if (!bRenderedAnything && !pScriptError && !pWorkflowError) {
            showMessage('No Script Deployments or Workflows Found', false);
            return;
        }

        oCardsContainer.appendChild(oFragment);
        bMinDisplayElapsed = true;
        hideSpinner();
        oMessage.classList.remove('visible');
    };

    /**
     * Re-renders the UI using the last fetched data.
     */
    const rerenderFromData = () => {

        if (!oLastData) {
            return;
        }

        const {SCRIPTS_DATA, WORKFLOWS_DATA, SCRIPT_ERROR, WORKFLOW_ERROR} = oLastData;
        oCardsContainer.replaceChildren();
        oMessage.classList.remove('visible');
        renderAll(SCRIPTS_DATA, WORKFLOWS_DATA, SCRIPT_ERROR, WORKFLOW_ERROR);
    };

    /**
     * Renders the drag-and-drop group order list.
     */
    const renderGroupOrderList = () => {

        if (!oGroupOrderList) {
            return;
        }

        oGroupOrderList.replaceChildren();

        aGroupOrder.forEach((pGroup, pIndex) => {

            const oItem = document.createElement('div');
            oItem.className = 'sm-order-item';
            oItem.draggable = true;
            oItem.dataset.index = pIndex;

            const oDragHandle = document.createElement('span');
            oDragHandle.className = 'sm-drag-handle';
            oDragHandle.title = 'Drag to reorder';
            oDragHandle.appendChild(createSvgIcon('ico-grip'));

            const oGroupLabel = document.createElement('span');
            oGroupLabel.className = 'sm-order-label';
            oGroupLabel.textContent = pGroup;

            oItem.appendChild(oDragHandle);
            oItem.appendChild(oGroupLabel);

            /* ── HTML5 Drag & Drop Events ── */

            oItem.addEventListener('dragstart', (pEvent) => {

                pEvent.dataTransfer.effectAllowed = 'move';
                pEvent.dataTransfer.setData('text/plain', pIndex);
                oItem.classList.add('dragging');
            });

            oItem.addEventListener('dragend', () => {

                oItem.classList.remove('dragging');
                document.querySelectorAll('.sm-order-item.drag-over').forEach((pEl) => {
                    pEl.classList.remove('drag-over');
                });
            });

            oItem.addEventListener('dragover', (pEvent) => {

                pEvent.preventDefault();
                pEvent.dataTransfer.dropEffect = 'move';
                oItem.classList.add('drag-over');
            });

            oItem.addEventListener('dragleave', () => {

                oItem.classList.remove('drag-over');
            });

            oItem.addEventListener('drop', (pEvent) => {

                pEvent.preventDefault();
                oItem.classList.remove('drag-over');

                const nFromIndex = parseInt(pEvent.dataTransfer.getData('text/plain'), 10);
                const nToIndex = parseInt(oItem.dataset.index, 10);

                if (nFromIndex === nToIndex) {
                    return;
                }

                /* Reorder the array */
                const [oMoved] = aGroupOrder.splice(nFromIndex, 1);
                aGroupOrder.splice(nToIndex, 0, oMoved);

                /* Persist and re-render */
                chrome.storage.local.set({groupOrder: aGroupOrder}).catch(() => {});
                renderGroupOrderList();
                rerenderFromData();
            });

            oGroupOrderList.appendChild(oItem);
        });
    };

    /* ────────────────────────────────────────────────
     * Toggle Event Handlers (pill buttons)
     * ──────────────────────────────────────────────── */

    oCompactToggle?.addEventListener('click', () => {

        oCompactToggle.classList.toggle('active');
        const bActive = oCompactToggle.classList.contains('active');
        document.body.classList.toggle('sm-compact', bActive);
        chrome.storage.local.set({compactMode: bActive}).catch(() => {});
    });

    oDarkToggle?.addEventListener('click', () => {

        oDarkToggle.classList.toggle('active');
        const bActive = oDarkToggle.classList.contains('active');
        document.body.classList.toggle('theme-dark', bActive);
        chrome.storage.local.set({darkMode: bActive}).catch(() => {});
    });

    oDeployedToggle?.addEventListener('click', () => {

        oDeployedToggle.classList.toggle('active');
        const bActive = oDeployedToggle.classList.contains('active');
        chrome.storage.local.set({deployedOnly: bActive}).catch(() => {});
        rerenderFromData();
    });

    oSortSelect?.addEventListener('change', () => {

        chrome.storage.local.set({sortOrder: oSortSelect.value}).catch(() => {});
        rerenderFromData();
    });

    /* ────────────────────────────────────────────────
     * Settings Drawer (Group Order — Drag & Drop)
     * ──────────────────────────────────────────────── */

    oSettingsBtn?.addEventListener('click', () => {

        const bVisible = oSettingsDrawer.style.display === 'block';
        oSettingsDrawer.style.display = bVisible ? 'none' : 'block';
        oSettingsBtn.classList.toggle('active', !bVisible);

        if (!bVisible) {
            renderGroupOrderList();
        }
    });

    /* ────────────────────────────────────────────────
     * Scheduler Panel — Environment Detection
     * ──────────────────────────────────────────────── */

    /**
     * Detects the NetSuite environment type from a URL.
     *
     * @param {string} pUrl
     * @returns {string}
     */
    const detectEnvironment = (pUrl) => {

        if (!pUrl) {
            return 'unknown';
        }

        try {
            const sHostname = new URL(pUrl).hostname;

            if (/-sb\d*\./.test(sHostname)) {
                return 'sandbox';
            }

            if (/-rp\./.test(sHostname)) {
                return 'preview';
            }

            if (/\.netsuite\.com/.test(sHostname)) {
                return 'production';
            }

        } catch (pErr) {
            /* ignore */
        }

        return 'unknown';
    };

    /**
     * Extracts the base account ID from a NetSuite URL.
     * e.g. 5555330.app.netsuite.com -> 5555330
     *      5555330-sb4.app.netsuite.com -> 5555330
     *      5555330_rp.app.netsuite.com -> 5555330
     *
     * @param {string} pUrl
     * @returns {string|null}
     */
    const extractBaseAccountId = (pUrl) => {

        if (!pUrl) {
            return null;
        }

        try {
            const sHost = new URL(pUrl).hostname;
            const sSubdomain = sHost.split('.')[0] || '';
            return sSubdomain.replace(/[-_](sb\d*|rp)$/i, '') || null;
        } catch (pErr) {
            return null;
        }
    };

    /* ────────────────────────────────────────────────
     * Scheduler Panel — Busy Lock
     * ──────────────────────────────────────────────── */

    let bSchedulerBusy = false;

    /**
     * Sets the busy state for all scheduler action buttons.
     *
     * @param {boolean} pBusy
     */
    const setSchedulerBusy = (pBusy) => {

        bSchedulerBusy = pBusy;

        if (oSchedulerCollectBtn) {
            oSchedulerCollectBtn.disabled = pBusy;
        }

        if (oSchedulerCheckBtn) {
            oSchedulerCheckBtn.disabled = pBusy;
        }

        if (oSchedulerApplyBtn) {
            oSchedulerApplyBtn.disabled = pBusy;
        }
    };

    /* ────────────────────────────────────────────────
     * Scheduler Panel — Rendering Helpers
     * ──────────────────────────────────────────────── */

    /**
     * Updates the selected count display and Select All checkbox state.
     */
    const updateSelectedCount = () => {

        const aChecked = oSchedulerList.querySelectorAll('.sm-sched-cb:checked');
        const aAll = oSchedulerList.querySelectorAll('.sm-sched-cb');

        if (oSchedulerSelectedCount) {
            oSchedulerSelectedCount.textContent = aChecked.length + ' / ' + aAll.length + ' selected';
        }

        if (oSchedulerSelectAll) {
            oSchedulerSelectAll.checked = aAll.length > 0 && aChecked.length === aAll.length;
            oSchedulerSelectAll.indeterminate = aChecked.length > 0 && aChecked.length < aAll.length;
        }

        if (oSchedulerApplyBtn) {
            oSchedulerApplyBtn.disabled = aChecked.length === 0;
        }
    };

    /**
     * Renders the stored deployment list with checkboxes and optional status badges.
     *
     * @param {Object} [pStatusMap] - Map of internalId to current status from the check command
     */
    const renderSchedulerStoredData = async (pStatusMap) => {

        const oStored = await chrome.storage.local.get(
            ['scheduledDeployments', 'scheduledCollectedAt', 'scheduledCollectedFrom', 'scheduledAccountId']
        ).catch(() => ({}));

        const aDeployments = oStored.scheduledDeployments || [];
        const sCollectedAt = oStored.scheduledCollectedAt || '';
        const sCollectedFrom = oStored.scheduledCollectedFrom || '';
        const sStoredAccountId = oStored.scheduledAccountId || null;
        const sCurrentAccountId = extractBaseAccountId(oTab?.url);

        oSchedulerList.replaceChildren();
        oSchedulerListHeader.style.display = 'none';

        if (aDeployments.length === 0) {
            oSchedulerStatus.textContent = 'No stored deployments. Collect from Production first.';
            oSchedulerStatus.className = 'sm-scheduler-status';
            oSchedulerApplyBtn.disabled = true;
            oSchedulerCheckBtn.disabled = true;
            oSchedulerClearBtn.disabled = true;
            return;
        }

        if (sStoredAccountId && sCurrentAccountId && sStoredAccountId !== sCurrentAccountId) {
            oSchedulerStatus.textContent = 'Stored data is from account ' + sStoredAccountId + '. Current account is ' + sCurrentAccountId + '.';
            oSchedulerStatus.className = 'sm-scheduler-status error';
            oSchedulerApplyBtn.disabled = true;
            oSchedulerCheckBtn.disabled = true;
            oSchedulerClearBtn.disabled = false;
            return;
        }

        oSchedulerStatus.textContent = aDeployments.length + ' deployments stored'
            + (sCollectedFrom ? ' from ' + sCollectedFrom : '')
            + (sCollectedAt ? ' on ' + sCollectedAt : '');
        oSchedulerStatus.className = 'sm-scheduler-status';
        oSchedulerCheckBtn.disabled = false;
        oSchedulerClearBtn.disabled = false;
        oSchedulerListHeader.style.display = 'flex';

        aDeployments.forEach((pDep) => {

            const oItem = document.createElement('div');
            oItem.className = 'sm-sched-item';

            const sCurrentStatus = pStatusMap ? pStatusMap[pDep.internalId] : null;
            const bAlreadyScheduled = sCurrentStatus === 'SCHEDULED';
            const bBlocked = sCurrentStatus === 'UNDEPLOYED' || sCurrentStatus === 'INACTIVE_SCRIPT';

            if (bBlocked) {
                oItem.classList.add('blocked');
            }

            const oCheckbox = document.createElement('input');
            oCheckbox.type = 'checkbox';
            oCheckbox.className = 'sm-sched-cb';
            oCheckbox.dataset.internalId = pDep.internalId;
            oCheckbox.checked = !bAlreadyScheduled && !bBlocked;

            if (bBlocked) {
                oCheckbox.disabled = true;
            }

            oCheckbox.addEventListener('change', updateSelectedCount);

            const oInfo = document.createElement('div');
            oInfo.className = 'sm-sched-item-info';

            const oName = document.createElement('span');
            oName.className = 'sm-sched-item-name';
            oName.textContent = pDep.title || pDep.scriptName || pDep.deploymentId;
            oName.title = (pDep.scriptName || '') + ' / ' + (pDep.title || '');

            const oId = document.createElement('span');
            oId.className = 'sm-sched-item-id';
            oId.textContent = pDep.deploymentId;

            oInfo.appendChild(oName);
            oInfo.appendChild(oId);

            oItem.appendChild(oCheckbox);
            oItem.appendChild(oInfo);

            if (pStatusMap && sCurrentStatus) {

                const oStatusBadge = document.createElement('span');
                oStatusBadge.className = 'sm-sched-item-badge';

                if (bAlreadyScheduled) {
                    oStatusBadge.classList.add('scheduled');
                    oStatusBadge.textContent = 'scheduled';
                } else if (sCurrentStatus === 'INACTIVE_SCRIPT') {
                    oStatusBadge.classList.add('blocked');
                    oStatusBadge.textContent = 'inactive script';
                } else if (sCurrentStatus === 'UNDEPLOYED') {
                    oStatusBadge.classList.add('blocked');
                    oStatusBadge.textContent = 'undeployed';
                } else {
                    oStatusBadge.classList.add('not-scheduled');
                    oStatusBadge.textContent = sCurrentStatus.toLowerCase().replace('notscheduled', 'not scheduled');
                }

                oItem.appendChild(oStatusBadge);
            }

            oSchedulerList.appendChild(oItem);
        });

        updateSelectedCount();
    };

    /**
     * Renders the selected deployments with per-line spinners before apply starts.
     *
     * @param {Array} pSelected
     */
    const renderApplyPending = (pSelected) => {

        oSchedulerList.replaceChildren();
        oSchedulerListHeader.style.display = 'none';

        pSelected.forEach((pDep) => {

            const oItem = document.createElement('div');
            oItem.className = 'sm-sched-item';
            oItem.dataset.internalId = pDep.internalId;

            const oStatusIcon = document.createElement('span');
            oStatusIcon.className = 'sm-sched-item-status pending';
            const oSpinEl = document.createElement('span');
            oSpinEl.className = 'sm-sched-spinner';
            oStatusIcon.appendChild(oSpinEl);

            const oInfo = document.createElement('div');
            oInfo.className = 'sm-sched-item-info';

            const oName = document.createElement('span');
            oName.className = 'sm-sched-item-name';
            oName.textContent = pDep.title || pDep.scriptName || pDep.deploymentId;

            const oId = document.createElement('span');
            oId.className = 'sm-sched-item-id';
            oId.textContent = pDep.deploymentId;

            oInfo.appendChild(oName);
            oInfo.appendChild(oId);

            oItem.appendChild(oStatusIcon);
            oItem.appendChild(oInfo);
            oSchedulerList.appendChild(oItem);
        });
    };

    /**
     * Updates a single row in the apply list from spinner to result icon.
     *
     * @param {Object} pResult
     */
    const updateApplyRow = (pResult) => {

        const sLookupId = pResult.originalInternalId || pResult.internalId;
        const oItem = oSchedulerList.querySelector('[data-internal-id="' + sLookupId + '"]');

        if (!oItem) {
            return;
        }

        const oOldStatus = oItem.querySelector('.sm-sched-item-status');

        if (!oOldStatus || !oOldStatus.classList.contains('pending')) {
            return;
        }

        const oStatusIcon = document.createElement('span');
        oStatusIcon.className = 'sm-sched-item-status';

        if (pResult.success) {
            oStatusIcon.classList.add('ok');
            oStatusIcon.appendChild(createSvgIcon('ico-check'));
            oStatusIcon.title = pResult.fallback
                ? 'Applied via script ID lookup (ID mismatch)'
                : 'Applied';
        } else {
            oStatusIcon.classList.add('fail');
            oStatusIcon.appendChild(createSvgIcon('ico-x'));
            oStatusIcon.title = pResult.error || 'Failed';
        }

        oOldStatus.replaceWith(oStatusIcon);
    };

    /**
     * Updates the status bar summary during/after apply.
     *
     * @param {number} pProcessed
     * @param {number} pTotal
     * @param {number} pSuccess
     * @param {number} pFailed
     */
    const updateApplyStatus = (pProcessed, pTotal, pSuccess, pFailed) => {

        if (pProcessed < pTotal) {
            oSchedulerStatus.textContent = 'Applying... ' + pProcessed + ' / ' + pTotal;
            oSchedulerStatus.className = 'sm-scheduler-status';
            return;
        }

        const aParts = [];
        if (pSuccess > 0) aParts.push(pSuccess + ' applied');
        if (pFailed > 0) aParts.push(pFailed + ' failed');

        oSchedulerStatus.textContent = aParts.join(', ');
        oSchedulerStatus.className = 'sm-scheduler-status' + (pFailed > 0 ? ' error' : ' success');
    };

    /**
     * Shows the error log in the scheduler list area.
     */
    const showApplyErrorLog = () => {

        oSchedulerList.replaceChildren();
        oSchedulerListHeader.style.display = 'none';
        oSchedulerStatus.textContent = aApplyErrors.length + ' error(s)';
        oSchedulerStatus.className = 'sm-scheduler-status error';

        aApplyErrors.forEach((pErr) => {

            const oItem = document.createElement('div');
            oItem.className = 'sm-sched-item';

            const oStatusIcon = document.createElement('span');
            oStatusIcon.className = 'sm-sched-item-status fail';
            oStatusIcon.appendChild(createSvgIcon('ico-x'));

            const oInfo = document.createElement('div');
            oInfo.className = 'sm-sched-item-info';

            const oName = document.createElement('span');
            oName.className = 'sm-sched-item-name';
            oName.textContent = pErr.title || pErr.scriptName || pErr.deploymentId;
            oName.title = pErr.error || 'Unknown error';

            const oDetail = document.createElement('span');
            oDetail.className = 'sm-sched-item-error';
            oDetail.textContent = pErr.error || 'Unknown error';

            oInfo.appendChild(oName);
            oInfo.appendChild(oDetail);

            oItem.appendChild(oStatusIcon);
            oItem.appendChild(oInfo);
            oSchedulerList.appendChild(oItem);
        });
    };

    /* ────────────────────────────────────────────────
     * Scheduler Panel — Polling for Results
     * ──────────────────────────────────────────────── */

    /**
     * Polls the content script for a scheduler result with retries.
     *
     * @param {number} pTabId
     * @param {number} pMaxRetries
     * @param {number} pIntervalMs
     * @param {string} pExpectedType
     * @returns {Promise<Object|null>}
     */
    const pollForSchedulerResult = async (pTabId, pMaxRetries, pIntervalMs, pExpectedType) => {

        for (let i = 0; i < pMaxRetries; i++) {

            await new Promise((pResolve) => setTimeout(pResolve, pIntervalMs));

            try {

                const oResponse = await new Promise((pResolve) => {

                    chrome.tabs.sendMessage(pTabId, {type: 'GET_SCHEDULER_RESULT', expectedType: pExpectedType}, (pResponse) => {

                        if (chrome.runtime.lastError) {
                            pResolve(null);
                        } else {
                            pResolve(pResponse);
                        }
                    });
                });

                if (oResponse) {
                    return oResponse;
                }

            } catch (pErr) {
                /* Retry */
            }
        }

        return null;
    };

    /* ────────────────────────────────────────────────
     * Main Data Fetch Flow
     * ──────────────────────────────────────────────── */

    const [oTab] = await chrome.tabs.query({active: true, currentWindow: true});

    /* ────────────────────────────────────────────────
     * Scheduler Panel — Init + Event Handlers
     * (set up after oTab is available)
     * ──────────────────────────────────────────────── */

    const sCurrentEnv = detectEnvironment(oTab?.url);

    if (oSchedulerEnv) {
        const sEnvLabels = {production: 'Production', sandbox: 'Sandbox', preview: 'Release Preview', unknown: 'Unknown'};
        oSchedulerEnv.textContent = sEnvLabels[sCurrentEnv] || sCurrentEnv;
        oSchedulerEnv.className = 'sm-env-badge ' + sCurrentEnv;
    }

    /**
     * Builds and renders the scheduler safety warning gate UI.
     */
    const buildSchedulerWarning = () => {

        const aRisks = [
            {
                severity: 'critical',
                title: 'Outbound API Calls (N/https)',
                desc: 'NetSuite does NOT block outbound HTTP/HTTPS from sandbox. Scripts calling Shopify, Salesforce, shipping APIs, payment gateways, or any external system will hit production endpoints with copied credentials.'
            },
            {
                severity: 'critical',
                title: 'SFTP & Banking Integrations',
                desc: 'SFTP credentials stored in custom records or script parameters transfer during refresh. ACH files, bank reconciliation data, and payment transmissions could reach production banking systems.'
            },
            {
                severity: 'high',
                title: 'Map/Reduce Scale Amplification',
                desc: 'Map/Reduce scripts process large volumes. A single re-enabled deployment could trigger thousands of outbound calls, mass emails, or external data corruption within minutes.'
            },
            {
                severity: 'high',
                title: 'Email Delivery Gaps',
                desc: 'Sandbox email preferences have documented exceptions. Security emails (password resets, 2FA, access notifications) and web store order emails bypass ALL sandbox email routing and reach real recipients.'
            },
            {
                severity: 'medium',
                title: 'Data Sync & External Corruption',
                desc: 'Scripts syncing inventory, customers, or orders to external platforms risk overwriting production data, creating duplicates, corrupting e-commerce inventory counts, or triggering erroneous fulfillment requests.'
            },
            {
                severity: 'medium',
                title: 'Stored Credentials in Custom Records',
                desc: 'API keys, tokens, and endpoint URLs stored in custom records or script deployment parameters are fully copied from production. Standard Payment Profiles are cleared, but custom-stored credentials are not.'
            }
        ];

        const aChecklist = [
            'Verify all integration endpoint URLs in script parameters and custom records',
            'Remove or redirect banking/SFTP credentials to test servers',
            'Confirm sandbox email preferences are set (redirect or suppress)',
            'Review each deployment individually, not all production schedules belong in sandbox',
            'Recreate TBA tokens and OAuth credentials for any integrations you do need active'
        ];

        oSchedulerWarning.replaceChildren();

        /* Header */
        const oHeader = document.createElement('div');
        oHeader.className = 'sm-warning-header';

        const oIconBox = document.createElement('div');
        oIconBox.className = 'sm-warning-icon-box';
        const oIconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        oIconSvg.setAttribute('class', 'sm-icon');
        const oIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        oIconUse.setAttribute('href', '#ico-info');
        oIconSvg.appendChild(oIconUse);
        oIconBox.appendChild(oIconSvg);

        const oHeaderText = document.createElement('div');
        const oTitle = document.createElement('div');
        oTitle.className = 'sm-warning-title';
        oTitle.textContent = 'DEPLOYMENT STATUS SYNC / SAFETY WARNING';
        const oSubtitle = document.createElement('div');
        oSubtitle.className = 'sm-warning-subtitle';
        oSubtitle.textContent = 'Read before syncing Scheduled / Map Reduce statuses from Production';
        oHeaderText.appendChild(oTitle);
        oHeaderText.appendChild(oSubtitle);

        oHeader.appendChild(oIconBox);
        oHeader.appendChild(oHeaderText);
        oSchedulerWarning.appendChild(oHeader);

        /* Body */
        const oBody = document.createElement('div');
        oBody.className = 'sm-warning-body';

        /* Core message */
        const oMsg = document.createElement('p');
        oMsg.className = 'sm-warning-msg';
        const oHl = document.createElement('span');
        oHl.className = 'sm-warning-hl';
        oHl.textContent = 'NetSuite intentionally resets';
        const oCode = document.createElement('code');
        oCode.className = 'sm-warning-code';
        oCode.textContent = 'Not Scheduled';
        oMsg.appendChild(oHl);
        oMsg.append(
            ' Scheduled and Map/Reduce deployments to ',
            oCode,
            ' during every sandbox refresh. This is a deliberate safety mechanism, not '
            + 'a bug. It prevents automated scripts from executing against '
            + 'production-connected systems using copied credentials and endpoints.'
        );
        oBody.appendChild(oMsg);

        /* Key fact */
        const oFact = document.createElement('div');
        oFact.className = 'sm-warning-fact';
        const oFactLabel = document.createElement('strong');
        oFactLabel.className = 'sm-warning-fact-label';
        oFactLabel.textContent = 'Key fact:';
        const oFactU = document.createElement('u');
        oFactU.textContent = 'not';
        oFact.appendChild(oFactLabel);
        oFact.append(
            ' NetSuite does ', oFactU,
            ' block outbound HTTP/HTTPS calls from sandbox. Any script '
            + 'using N/https will reach production external endpoints immediately. '
            + 'Credentials stored in custom records and script parameters are fully '
            + 'copied during refresh.'
        );
        oBody.appendChild(oFact);

        /* Risk toggle */
        const oToggle = document.createElement('button');
        oToggle.className = 'sm-warning-toggle';
        const oArrow = document.createElement('span');
        oArrow.className = 'sm-warning-arrow';
        oArrow.textContent = '\u25B8';
        oToggle.appendChild(oArrow);
        oToggle.append(' View detailed risk breakdown (' + aRisks.length + ' categories)');

        const oRiskList = document.createElement('div');
        oRiskList.className = 'sm-warning-risks';
        oRiskList.style.display = 'none';

        aRisks.forEach((pRisk) => {
            const oEl = document.createElement('div');
            oEl.className = 'sm-warning-risk ' + pRisk.severity;

            const oRiskTitle = document.createElement('div');
            oRiskTitle.className = 'sm-warning-risk-title';
            const oDot = document.createElement('span');
            oDot.className = 'sm-warning-dot ' + pRisk.severity;
            oRiskTitle.appendChild(oDot);
            oRiskTitle.append(' ' + pRisk.title);

            const oRiskDesc = document.createElement('div');
            oRiskDesc.className = 'sm-warning-risk-desc';
            oRiskDesc.textContent = pRisk.desc;

            oEl.appendChild(oRiskTitle);
            oEl.appendChild(oRiskDesc);
            oRiskList.appendChild(oEl);
        });

        /* Info note */
        const oNote = document.createElement('div');
        oNote.className = 'sm-warning-note';
        const oNoteLabel = document.createElement('strong');
        oNoteLabel.textContent = 'Note:';
        const oNoteActive = document.createElement('strong');
        oNoteActive.textContent = 'remain active';
        oNote.appendChild(oNoteLabel);
        oNote.append(
            ' This reset only affects Scheduled and Map/Reduce '
            + 'deployments. User Event Scripts, Suitelets, RESTlets, Client Scripts, '
            + 'and Workflows ', oNoteActive,
            ' after refresh and may also contain outbound integrations.'
        );
        oRiskList.appendChild(oNote);

        oToggle.addEventListener('click', () => {
            const bExpanded = oRiskList.style.display !== 'none';
            oRiskList.style.display = bExpanded ? 'none' : 'flex';
            oArrow.classList.toggle('expanded', !bExpanded);
            oToggle.lastChild.textContent = ' ' + (!bExpanded ? 'Hide' : 'View')
                + ' detailed risk breakdown (' + aRisks.length + ' categories)';
        });

        oBody.appendChild(oToggle);
        oBody.appendChild(oRiskList);
        oSchedulerWarning.appendChild(oBody);

        /* Checklist */
        const oCheckSection = document.createElement('div');
        oCheckSection.className = 'sm-warning-checklist';

        const oCheckLabel = document.createElement('div');
        oCheckLabel.className = 'sm-warning-checklist-label';
        oCheckLabel.textContent = 'Pre-sync verification checklist';
        oCheckSection.appendChild(oCheckLabel);

        const aCheckboxes = [];

        aChecklist.forEach((pItem) => {
            const oLabel = document.createElement('label');
            oLabel.className = 'sm-warning-check';

            const oCb = document.createElement('input');
            oCb.type = 'checkbox';
            oCb.addEventListener('change', updateProceedState);
            aCheckboxes.push(oCb);

            const oText = document.createElement('span');
            oText.className = 'sm-warning-check-text';
            oText.textContent = pItem;

            oCb.addEventListener('change', () => {
                oText.classList.toggle('checked', oCb.checked);
            });

            oLabel.appendChild(oCb);
            oLabel.appendChild(oText);
            oCheckSection.appendChild(oLabel);
        });

        oSchedulerWarning.appendChild(oCheckSection);

        /* Action bar */
        const oActions = document.createElement('div');
        oActions.className = 'sm-warning-actions';

        const oAckLabel = document.createElement('label');
        oAckLabel.className = 'sm-warning-ack';

        const oAckCb = document.createElement('input');
        oAckCb.type = 'checkbox';
        oAckCb.addEventListener('change', updateProceedState);

        const oAckText = document.createElement('span');
        oAckText.textContent = 'I understand the risks and have verified my environment';

        oAckLabel.appendChild(oAckCb);
        oAckLabel.appendChild(oAckText);

        const oProceed = document.createElement('button');
        oProceed.className = 'sm-warning-proceed';
        oProceed.textContent = 'Proceed with Sync';
        oProceed.disabled = true;

        function updateProceedState() {
            const bAllChecked = aCheckboxes.every((pCb) => pCb.checked);
            oProceed.disabled = !(bAllChecked && oAckCb.checked);
        }

        oProceed.addEventListener('click', () => {
            oSchedulerWarning.style.display = 'none';
            oSchedulerPanel.style.display = 'block';
            renderSchedulerStoredData();
        });

        oActions.appendChild(oAckLabel);
        oActions.appendChild(oProceed);
        oSchedulerWarning.appendChild(oActions);

        /* Footer */
        const oFooter = document.createElement('div');
        oFooter.className = 'sm-warning-footer';
        oFooter.textContent = 'This is an industry-standard safety practice. Salesforce, SAP, and other enterprise platforms apply identical resets during sandbox refresh.';
        oSchedulerWarning.appendChild(oFooter);
    };

    const oFooterEl = document.querySelector('.sm-footer');

    /**
     * Toggles visibility of main content siblings when scheduler views are active.
     *
     * @param {boolean} bShow - true to hide cards/footer/spinner, false to restore
     */
    const setSchedulerView = (bShow) => {
        const sCards = bShow ? 'none' : '';
        oCardsContainer.style.display = sCards;
        oFooterEl.style.display = sCards;
        oSpinner.style.display = sCards;
    };

    oSchedulerBtn?.addEventListener('click', async () => {

        const bWarningVisible = oSchedulerWarning.style.display === 'block';
        const bPanelVisible = oSchedulerPanel.style.display === 'block';

        if (bWarningVisible || bPanelVisible) {
            oSchedulerWarning.style.display = 'none';
            oSchedulerPanel.style.display = 'none';
            oSchedulerBtn.classList.remove('active');
            setSchedulerView(false);
            if (oMessage.textContent) {
                oMessage.classList.add('visible');
            }
            return;
        }

        oMessage.classList.remove('visible');
        oSchedulerBtn.classList.add('active');
        setSchedulerView(true);

        const oStored = await chrome.storage.local.get(['scheduledDeployments']).catch(() => ({}));

        const bHasData = oStored.scheduledDeployments && oStored.scheduledDeployments.length > 0;

        if (bHasData) {
            oSchedulerPanel.style.display = 'block';
            renderSchedulerStoredData();
        } else {
            buildSchedulerWarning();
            oSchedulerWarning.style.display = 'block';
        }
    });

    oSchedulerSelectAll?.addEventListener('change', () => {

        const bChecked = oSchedulerSelectAll.checked;

        oSchedulerList.querySelectorAll('.sm-sched-cb:not(:disabled)').forEach((pCb) => {
            pCb.checked = bChecked;
        });

        updateSelectedCount();
    });

    oSchedulerCollectBtn?.addEventListener('click', async () => {

        if (!oTab || bSchedulerBusy) {
            return;
        }

        setSchedulerBusy(true);
        oSchedulerStatus.textContent = 'Collecting...';
        oSchedulerStatus.className = 'sm-scheduler-status';
        oSchedulerList.replaceChildren();
        oSchedulerListHeader.style.display = 'none';

        try {

            const oInjectResponse = await chrome.runtime.sendMessage({
                type: 'INJECT_SCHEDULER',
                tabId: oTab.id,
                command: 'collect'
            });

            if (oInjectResponse?.error) {
                oSchedulerStatus.textContent = 'Injection failed: ' + oInjectResponse.error;
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            const oResult = await pollForSchedulerResult(oTab.id, 15, 500, 'SCHEDULER_COLLECT_RESULT');

            if (!oResult) {
                oSchedulerStatus.textContent = 'Timed out waiting for results. Try again.';
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            if (oResult.error) {
                oSchedulerStatus.textContent = 'Error: ' + oResult.error;
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            const aDeployments = oResult.data || [];
            const sNow = new Date().toLocaleString();

            await chrome.storage.local.set({
                scheduledDeployments: aDeployments,
                scheduledCollectedAt: sNow,
                scheduledCollectedFrom: sCurrentEnv,
                scheduledAccountId: extractBaseAccountId(oTab?.url)
            }).catch(() => {});

            await renderSchedulerStoredData();
            oSchedulerStatus.textContent = 'Collected ' + aDeployments.length + ' deployments.';
            oSchedulerStatus.className = 'sm-scheduler-status success';

        } catch (pErr) {
            oSchedulerStatus.textContent = 'Error: ' + pErr.message;
            oSchedulerStatus.className = 'sm-scheduler-status error';
        }

        setSchedulerBusy(false);
    });

    oSchedulerCheckBtn?.addEventListener('click', async () => {

        if (!oTab || bSchedulerBusy) {
            return;
        }

        const oStored = await chrome.storage.local.get(['scheduledDeployments']).catch(() => ({}));

        const aDeployments = oStored.scheduledDeployments || [];

        if (aDeployments.length === 0) {
            return;
        }

        setSchedulerBusy(true);
        oSchedulerStatus.textContent = 'Checking status in this environment...';
        oSchedulerStatus.className = 'sm-scheduler-status';

        try {

            const oInjectResponse = await chrome.runtime.sendMessage({
                type: 'INJECT_SCHEDULER',
                tabId: oTab.id,
                command: 'check',
                deployments: aDeployments
            });

            if (oInjectResponse?.error) {
                oSchedulerStatus.textContent = 'Injection failed: ' + oInjectResponse.error;
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            const oResult = await pollForSchedulerResult(oTab.id, 15, 500, 'SCHEDULER_CHECK_RESULT');

            if (!oResult) {
                oSchedulerStatus.textContent = 'Timed out waiting for status check. Try again.';
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            if (oResult.error) {
                oSchedulerStatus.textContent = 'Error: ' + oResult.error;
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            /* Re-render the list with status data; already-scheduled items will be unchecked */
            const oStatusMap = oResult.data || {};
            await renderSchedulerStoredData(oStatusMap);

            const aStatuses = Object.values(oStatusMap);
            const nScheduled = aStatuses.filter((pStatus) => pStatus === 'SCHEDULED').length;
            const nBlocked = aStatuses.filter((pStatus) => pStatus === 'UNDEPLOYED' || pStatus === 'INACTIVE_SCRIPT').length;
            const nTotal = aDeployments.length;
            const nRelevant = nTotal - nBlocked;

            let sMsg = nScheduled + ' / ' + nRelevant + ' scheduled';
            if (nBlocked > 0) {
                sMsg += ', ' + nBlocked + ' skipped';
            }
            oSchedulerStatus.textContent = sMsg;
            oSchedulerStatus.className = 'sm-scheduler-status' + (nScheduled === nRelevant ? ' success' : '');

        } catch (pErr) {
            oSchedulerStatus.textContent = 'Error: ' + pErr.message;
            oSchedulerStatus.className = 'sm-scheduler-status error';
        }

        setSchedulerBusy(false);
    });

    oSchedulerApplyBtn?.addEventListener('click', async () => {

        if (!oTab || bSchedulerBusy) {
            return;
        }

        const oStored = await chrome.storage.local.get(['scheduledDeployments']).catch(() => ({}));

        const aAllDeployments = oStored.scheduledDeployments || [];
        const aCheckedIds = new Set();

        oSchedulerList.querySelectorAll('.sm-sched-cb:checked').forEach((pCb) => {
            aCheckedIds.add(pCb.dataset.internalId);
        });

        const aSelected = aAllDeployments.filter((pDep) => aCheckedIds.has(String(pDep.internalId)));

        if (aSelected.length === 0) {
            oSchedulerStatus.textContent = 'No deployments selected.';
            oSchedulerStatus.className = 'sm-scheduler-status';
            return;
        }

        setSchedulerBusy(true);
        aApplyErrors = [];
        oSchedulerLogBtn.style.display = 'none';
        renderApplyPending(aSelected);
        oSchedulerStatus.textContent = 'Applying... 0 / ' + aSelected.length;
        oSchedulerStatus.className = 'sm-scheduler-status';

        try {

            const oInjectResponse = await chrome.runtime.sendMessage({
                type: 'INJECT_SCHEDULER',
                tabId: oTab.id,
                command: 'apply',
                deployments: aSelected
            });

            if (oInjectResponse?.error) {
                oSchedulerStatus.textContent = 'Injection failed: ' + oInjectResponse.error;
                oSchedulerStatus.className = 'sm-scheduler-status error';
                setSchedulerBusy(false);
                return;
            }

            const nTotal = aSelected.length;
            let nProcessed = 0;
            let nSuccess = 0;
            let nFailed = 0;
            const oSeen = new Set();

            for (let i = 0; i < 120; i++) {

                await new Promise((pResolve) => setTimeout(pResolve, 250));

                try {

                    const aProgress = await new Promise((pResolve) => {
                        chrome.tabs.sendMessage(oTab.id, {type: 'GET_SCHEDULER_PROGRESS'}, (pResponse) => {
                            pResolve(chrome.runtime.lastError ? [] : (pResponse || []));
                        });
                    });

                    aProgress.forEach((pItem) => {

                        const sTrackId = pItem.originalInternalId || pItem.internalId;

                        if (oSeen.has(sTrackId)) {
                            return;
                        }

                        oSeen.add(sTrackId);
                        nProcessed++;
                        updateApplyRow(pItem);

                        if (pItem.success) {
                            nSuccess++;
                        } else {
                            nFailed++;
                            aApplyErrors.push(pItem);
                        }

                        updateApplyStatus(nProcessed, nTotal, nSuccess, nFailed);
                    });

                } catch (pErr) {
                    /* Retry */
                }

                if (nProcessed >= nTotal) {
                    break;
                }
            }

            if (nProcessed < nTotal) {
                oSchedulerStatus.textContent = 'Timed out. ' + nProcessed + ' / ' + nTotal + ' processed.';
                oSchedulerStatus.className = 'sm-scheduler-status error';
            }

            if (aApplyErrors.length > 0) {
                oSchedulerLogBtn.style.display = '';
            }

        } catch (pErr) {
            oSchedulerStatus.textContent = 'Error: ' + pErr.message;
            oSchedulerStatus.className = 'sm-scheduler-status error';
        }

        setSchedulerBusy(false);
    });

    oSchedulerLogBtn?.addEventListener('click', () => {

        if (aApplyErrors.length > 0) {
            showApplyErrorLog();
        }
    });

    oSchedulerClearBtn?.addEventListener('click', async () => {

        aApplyErrors = [];
        oSchedulerLogBtn.style.display = 'none';

        await chrome.storage.local.remove(['scheduledDeployments', 'scheduledCollectedAt', 'scheduledCollectedFrom', 'scheduledAccountId']).catch(() => {});

        await renderSchedulerStoredData();
    });

    /* ────────────────────────────────────────────────
     * Gate: require NetSuite record page for scripts view
     * ──────────────────────────────────────────────── */

    if (!oTab || !oTab.url || !oTab.url.includes('netsuite.com')) {

        showMessage('Navigate to a NetSuite page to use this extension.', false);
        return;
    }

    let bHasRecordId = false;

    try {
        bHasRecordId = new URL(oTab.url).searchParams.has('id');
    } catch (pErr) {
        /* invalid URL, treat as no record */
    }

    if (!bHasRecordId) {

        showMessage('Open a NetSuite record to view its scripts.', false);
        return;
    }

    /* Extract the origin for building NetSuite URLs */
    const sOrigin = new URL(oTab.url).origin;

    /* ────────────────────────────────────────────────
     * Scripted Records Button Handler
     * ──────────────────────────────────────────────── */

    oScriptedRecordsBtn?.addEventListener('click', () => {

        if (!oLastData || !oLastData.RECORD_TYPE) {
            return;
        }

        const sUrl = `${sOrigin}/app/common/scripting/scriptedrecord.nl?id=${oLastData.RECORD_TYPE.toUpperCase()}`;
        chrome.tabs.create({url: sUrl}).catch(() => {});
    });

    document.querySelectorAll('.sm-footer a[target="_blank"]').forEach((pLink) => {
        pLink.addEventListener('click', (pEvent) => {
            pEvent.preventDefault();
            chrome.tabs.create({url: pEvent.currentTarget.href}).catch(() => {});
        });
    });

    /* ────────────────────────────────────────────────
     * Data Polling Logic
     * ──────────────────────────────────────────────── */

    /**
     * Polls the content script for data with retries.
     *
     * @param {number} pTabId
     * @param {number} pMaxRetries
     * @param {number} pIntervalMs
     */
    const pollForData = async (pTabId, pMaxRetries, pIntervalMs) => {

        for (let i = 0; i < pMaxRetries; i++) {

            await new Promise((pResolve) => setTimeout(pResolve, pIntervalMs));

            try {

                const oResponse = await new Promise((pResolve) => {

                    chrome.tabs.sendMessage(pTabId, {type: 'GET_SCRIPTS_DATA'}, (pResponse) => {

                        if (chrome.runtime.lastError) {
                            pResolve(null);
                        } else {
                            pResolve(pResponse);
                        }
                    });
                });

                if (oResponse) {

                    /* Check for error from nsmain.js */
                    if (oResponse.error) {
                        showMessage(oResponse.message || oResponse.error, true);
                        return;
                    }

                    if (oResponse.data) {

                        /* Store in memory for re-renders (sort/toggle changes) */
                        oLastData = oResponse.data;

                        /* Enable Scripted Records button now that we have the record type */
                        if (oLastData.RECORD_TYPE && oScriptedRecordsBtn) {
                            oScriptedRecordsBtn.disabled = false;
                        }

                        /* Fetch stack order from scripted record page */
                        if (oLastData.RECORD_TYPE && oLastData.SCRIPTS_DATA?.length) {

                            try {
                                const oStackMap = await fetchStackOrder(sOrigin, oLastData.RECORD_TYPE);

                                if (oStackMap.size > 0) {
                                    applyStackOrder(oLastData.SCRIPTS_DATA, oStackMap);
                                    bStackOrderAvailable = true;
                                }
                            } catch (pErr) {
                                /* Stack order is non-critical -- continue without it */
                            }
                        }

                        const {SCRIPTS_DATA, WORKFLOWS_DATA, SCRIPT_ERROR, WORKFLOW_ERROR} = oLastData;

                        oCardsContainer.replaceChildren();
                        renderAll(SCRIPTS_DATA, WORKFLOWS_DATA, SCRIPT_ERROR, WORKFLOW_ERROR);
                        return;
                    }
                }

            } catch (pErr) {
                /* Retry */
            }
        }

        showMessage('Timed out waiting for data. Try clicking Refresh.', true);
    };

    /**
     * Initiates the data fetch process.
     *
     * @param {boolean} pForceRefresh
     */
    const fetchAndRenderData = async (pForceRefresh) => {

        try {

            /* Inject content script via background SW */
            const oInjectResponse = await chrome.runtime.sendMessage({
                type: 'INJECT_AND_GET_DATA',
                tabId: oTab.id,
                forceRefresh: !!pForceRefresh
            });

            if (oInjectResponse?.error) {
                showMessage('Injection failed: ' + oInjectResponse.error, true);
                return;
            }

            /* Poll for data */
            await pollForData(oTab.id, 8, 400);

        } catch (pErr) {
            showMessage('Error: ' + pErr.message, true);
        }
    };

    /* ────────────────────────────────────────────────
     * Refresh Button Handler
     * ──────────────────────────────────────────────── */

    oRefreshBtn?.addEventListener('click', () => {

        resetSpinner();
        fetchAndRenderData(true);
    });

    /* Initial fetch */
    await fetchAndRenderData(false);
};
