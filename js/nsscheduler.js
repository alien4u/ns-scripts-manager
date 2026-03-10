(() => {

    const oDataEl = document.getElementById('__ns_scheduler_data__');

    if (!oDataEl) {
        return;
    }

    const sCommand = oDataEl.dataset.command;
    const sDeployments = oDataEl.dataset.deployments || '[]';
    oDataEl.remove();

    if (sCommand === 'collect') {
        collectScheduledDeployments();
    } else if (sCommand === 'check') {
        checkDeploymentStatus(JSON.parse(sDeployments));
    } else if (sCommand === 'apply') {
        applyScheduledDeployments(JSON.parse(sDeployments));
    }

    /* ----------------------------------------------------------------
     * Collect — find all Scheduled/MapReduce deployments with status SCHEDULED
     * ---------------------------------------------------------------- */

    /**
     * Routes to the appropriate SuiteScript version for collecting scheduled deployments.
     */
    function collectScheduledDeployments() {

        const bHasRequire = typeof require !== 'undefined';
        const bHasNlapi = typeof nlapiSearchRecord !== 'undefined';

        if (bHasRequire) {
            collectV2();
        } else if (bHasNlapi) {
            collectV1();
        } else {
            postResult('SCHEDULER_COLLECT_RESULT', null, 'Neither SuiteScript 2.x nor 1.0 is available on this page.');
        }
    }

    /**
     * Collects scheduled deployments using SuiteScript 2.x N/search.
     */
    function collectV2() {

        try {

            require(['N/search'], (pSearch) => {

                try {

                    const aResults = [];

                    pSearch.create({
                        type: 'scriptdeployment',
                        filters: [
                            ['script.scripttype', 'anyof', ['SCHEDULED', 'MAPREDUCE']],
                            'AND',
                            ['status', 'is', 'SCHEDULED'],
                            'AND',
                            ['script.isinactive', 'is', 'F'],
                            'AND',
                            ['isdeployed', 'is', 'T']
                        ],
                        columns: [
                            pSearch.createColumn({name: 'scriptid'}),
                            pSearch.createColumn({name: 'title'}),
                            pSearch.createColumn({name: 'status'}),
                            pSearch.createColumn({name: 'script'}),
                            pSearch.createColumn({name: 'scriptid', join: 'script'})
                        ]
                    }).run().each((pResult) => {

                        aResults.push({
                            internalId: pResult.id,
                            deploymentId: pResult.getValue('scriptid'),
                            title: pResult.getValue('title'),
                            scriptName: pResult.getText('script'),
                            scriptId: pResult.getValue({name: 'scriptid', join: 'script'})
                        });

                        return true;
                    });

                    const sWarning = aResults.length >= 4000
                        ? 'Results may be truncated (4000 limit reached).'
                        : null;
                    postResult('SCHEDULER_COLLECT_RESULT', aResults, sWarning);

                } catch (e) {
                    postResult('SCHEDULER_COLLECT_RESULT', null, safeErrorMessage(e));
                }
            });

        } catch (e) {
            postResult('SCHEDULER_COLLECT_RESULT', null, safeErrorMessage(e));
        }
    }

    /**
     * Collects scheduled deployments using SuiteScript 1.0 nlapiSearchRecord.
     */
    function collectV1() {

        try {

            const aResults = [];

            const oSearchResults = nlapiSearchRecord('scriptdeployment', null,
                [
                    ['script.scripttype', 'anyof', ['SCHEDULED', 'MAPREDUCE']],
                    'AND',
                    ['status', 'is', 'SCHEDULED'],
                    'AND',
                    ['script.isinactive', 'is', 'F'],
                    'AND',
                    ['isdeployed', 'is', 'T']
                ],
                [
                    new nlobjSearchColumn('scriptid'),
                    new nlobjSearchColumn('title'),
                    new nlobjSearchColumn('status'),
                    new nlobjSearchColumn('script'),
                    new nlobjSearchColumn('scriptid', 'script')
                ]
            );

            if (oSearchResults) {

                oSearchResults.forEach((pResult) => {

                    aResults.push({
                        internalId: pResult.getId(),
                        deploymentId: pResult.getValue('scriptid'),
                        title: pResult.getValue('title'),
                        scriptName: pResult.getText('script'),
                        scriptId: pResult.getValue('scriptid', 'script')
                    });
                });
            }

            const sWarning = oSearchResults && oSearchResults.length >= 1000
                ? 'Results may be truncated (1000 limit reached).'
                : null;
            postResult('SCHEDULER_COLLECT_RESULT', aResults, sWarning);

        } catch (e) {
            postResult('SCHEDULER_COLLECT_RESULT', null, safeErrorMessage(e));
        }
    }

    /* ----------------------------------------------------------------
     * Check — look up current status for a list of deployments by internal ID
     * ---------------------------------------------------------------- */

    /**
     * Routes to the appropriate SuiteScript version for checking deployment status.
     *
     * @param {Array} pDeployments
     */
    function checkDeploymentStatus(pDeployments) {

        if (!pDeployments || !pDeployments.length) {
            postResult('SCHEDULER_CHECK_RESULT', null, 'No deployments to check.');
            return;
        }

        const bHasRequire = typeof require !== 'undefined';
        const bHasNlapi = typeof nlapiSearchRecord !== 'undefined';

        if (bHasRequire) {
            checkV2(pDeployments);
        } else if (bHasNlapi) {
            checkV1(pDeployments);
        } else {
            postResult('SCHEDULER_CHECK_RESULT', null, 'Neither SuiteScript 2.x nor 1.0 is available on this page.');
        }
    }

    /**
     * Builds an internalid anyof filter from a list of deployments.
     *
     * @param {Array} pDeployments
     * @returns {Array}
     */
    function buildIdFilters(pDeployments) {

        return [['internalid', 'anyof', pDeployments.map((pDep) => pDep.internalId)]];
    }

    /**
     * Finds deployments not matched by internal ID and resolves them by scriptid.
     * Keys results by the original (production) internal ID so the popup can match.
     *
     * @param {Object} pSearch - N/search module
     * @param {Array} pDeployments
     * @param {Object} pStatusMap - Map already populated by internal ID search
     */
    function checkFallbackV2(pSearch, pDeployments, pStatusMap) {

        const aMissing = pDeployments.filter((pDep) =>
            pDep.deploymentId && !pStatusMap[pDep.internalId]
        );

        if (aMissing.length === 0) {
            return;
        }

        const oScriptIdToOrigId = {};

        aMissing.forEach((pDep) => {
            oScriptIdToOrigId[pDep.deploymentId] = pDep.internalId;
        });

        const aScriptIds = aMissing.map((pDep) => pDep.deploymentId);

        pSearch.create({
            type: 'scriptdeployment',
            filters: buildScriptIdFilters(aScriptIds),
            columns: [
                pSearch.createColumn({name: 'scriptid'}),
                pSearch.createColumn({name: 'status'}),
                pSearch.createColumn({name: 'isdeployed'}),
                pSearch.createColumn({name: 'isinactive', join: 'script'})
            ]
        }).run().each((pResult) => {

            const sScriptId = pResult.getValue('scriptid');
            const sOrigId = oScriptIdToOrigId[sScriptId];

            if (!sOrigId || pStatusMap[sOrigId]) {
                return true;
            }

            if (pResult.getValue({name: 'isinactive', join: 'script'}) === 'T') {
                pStatusMap[sOrigId] = 'INACTIVE_SCRIPT';
            } else if (pResult.getValue('isdeployed') === 'F') {
                pStatusMap[sOrigId] = 'UNDEPLOYED';
            } else if (pStatusMap[sOrigId] !== 'SCHEDULED') {
                pStatusMap[sOrigId] = pResult.getValue('status');
            }

            return true;
        });
    }

    /**
     * Checks deployment status using SuiteScript 2.x N/search.
     *
     * @param {Array} pDeployments
     */
    function checkV2(pDeployments) {

        try {

            require(['N/search'], (pSearch) => {

                try {

                    const oStatusMap = {};

                    pSearch.create({
                        type: 'scriptdeployment',
                        filters: buildIdFilters(pDeployments),
                        columns: [
                            pSearch.createColumn({name: 'status'}),
                            pSearch.createColumn({name: 'isdeployed'}),
                            pSearch.createColumn({name: 'isinactive', join: 'script'})
                        ]
                    }).run().each((pResult) => {

                        if (pResult.getValue({name: 'isinactive', join: 'script'}) === 'T') {
                            oStatusMap[pResult.id] = 'INACTIVE_SCRIPT';
                        } else if (pResult.getValue('isdeployed') === 'F') {
                            oStatusMap[pResult.id] = 'UNDEPLOYED';
                        } else {
                            oStatusMap[pResult.id] = pResult.getValue('status');
                        }
                        return true;
                    });

                    try {
                        checkFallbackV2(pSearch, pDeployments, oStatusMap);
                    } catch (ignore) {
                        /* fallback check failed, proceed with what we have */
                    }

                    postResult('SCHEDULER_CHECK_RESULT', oStatusMap, null);

                } catch (e) {
                    postResult('SCHEDULER_CHECK_RESULT', null, safeErrorMessage(e));
                }
            });

        } catch (e) {
            postResult('SCHEDULER_CHECK_RESULT', null, safeErrorMessage(e));
        }
    }

    /**
     * Finds deployments not matched by internal ID and resolves them by scriptid (SS 1.0).
     * Keys results by the original (production) internal ID so the popup can match.
     *
     * @param {Array} pDeployments
     * @param {Object} pStatusMap - Map already populated by internal ID search
     */
    function checkFallbackV1(pDeployments, pStatusMap) {

        const aMissing = pDeployments.filter((pDep) =>
            pDep.deploymentId && !pStatusMap[pDep.internalId]
        );

        if (aMissing.length === 0) {
            return;
        }

        const oScriptIdToOrigId = {};

        aMissing.forEach((pDep) => {
            oScriptIdToOrigId[pDep.deploymentId] = pDep.internalId;
        });

        const aScriptIds = aMissing.map((pDep) => pDep.deploymentId);

        const oResults = nlapiSearchRecord('scriptdeployment', null,
            buildScriptIdFilters(aScriptIds),
            [
                new nlobjSearchColumn('scriptid'),
                new nlobjSearchColumn('status'),
                new nlobjSearchColumn('isdeployed'),
                new nlobjSearchColumn('isinactive', 'script')
            ]
        );

        if (oResults) {

            oResults.forEach((pResult) => {

                const sScriptId = pResult.getValue('scriptid');
                const sOrigId = oScriptIdToOrigId[sScriptId];

                if (!sOrigId || pStatusMap[sOrigId]) {
                    return;
                }

                if (pResult.getValue('isinactive', 'script') === 'T') {
                    pStatusMap[sOrigId] = 'INACTIVE_SCRIPT';
                } else if (pResult.getValue('isdeployed') === 'F') {
                    pStatusMap[sOrigId] = 'UNDEPLOYED';
                } else if (pStatusMap[sOrigId] !== 'SCHEDULED') {
                    pStatusMap[sOrigId] = pResult.getValue('status');
                }
            });
        }
    }

    /**
     * Checks deployment status using SuiteScript 1.0 nlapiSearchRecord.
     *
     * @param {Array} pDeployments
     */
    function checkV1(pDeployments) {

        try {

            const oStatusMap = {};

            const oSearchResults = nlapiSearchRecord('scriptdeployment', null,
                buildIdFilters(pDeployments),
                [
                    new nlobjSearchColumn('status'),
                    new nlobjSearchColumn('isdeployed'),
                    new nlobjSearchColumn('isinactive', 'script')
                ]
            );

            if (oSearchResults) {

                oSearchResults.forEach((pResult) => {

                    if (pResult.getValue('isinactive', 'script') === 'T') {
                        oStatusMap[pResult.getId()] = 'INACTIVE_SCRIPT';
                    } else if (pResult.getValue('isdeployed') === 'F') {
                        oStatusMap[pResult.getId()] = 'UNDEPLOYED';
                    } else {
                        oStatusMap[pResult.getId()] = pResult.getValue('status');
                    }
                });
            }

            try {
                checkFallbackV1(pDeployments, oStatusMap);
            } catch (ignore) {
                /* fallback check failed, proceed with what we have */
            }

            postResult('SCHEDULER_CHECK_RESULT', oStatusMap, null);

        } catch (e) {
            postResult('SCHEDULER_CHECK_RESULT', null, safeErrorMessage(e));
        }
    }

    /* ----------------------------------------------------------------
     * Apply — set selected deployments to SCHEDULED using internal ID
     * ---------------------------------------------------------------- */

    /**
     * Safely extracts an error message string. NetSuite error objects in strict
     * mode can throw when accessing certain properties like caller/callee.
     *
     * @param {*} pError
     * @returns {string}
     */
    function safeErrorMessage(pError) {

        try {
            if (pError && typeof pError.message === 'string') {
                return pError.message;
            }
        } catch (ignore) {
            /* strict mode restriction on error object */
        }

        try {
            return String(pError);
        } catch (ignore) {
            return 'Unknown error';
        }
    }

    /**
     * Routes to the appropriate SuiteScript version for applying scheduled status.
     *
     * @param {Array} pDeployments
     */
    function applyScheduledDeployments(pDeployments) {

        if (!pDeployments || !pDeployments.length) {
            postResult('SCHEDULER_APPLY_RESULT', null, 'No deployments to apply.');
            return;
        }

        const bHasRequire = typeof require !== 'undefined';
        const bHasNlapi = typeof nlapiSubmitField !== 'undefined';

        if (bHasRequire) {
            applyV2(pDeployments);
        } else if (bHasNlapi) {
            applyV1(pDeployments);
        } else {
            postResult('SCHEDULER_APPLY_RESULT', null, 'Neither SuiteScript 2.x nor 1.0 is available on this page.');
        }
    }

    /**
     * Builds OR-chained scriptid filters for text field matching.
     * e.g. [['scriptid','is','id1'],'OR',['scriptid','is','id2'],...]
     *
     * @param {Array} pScriptIds
     * @returns {Array}
     */
    function buildScriptIdFilters(pScriptIds) {

        const aFilters = [];

        pScriptIds.forEach((pId, pIdx) => {

            if (pIdx > 0) {
                aFilters.push('OR');
            }

            aFilters.push(['scriptid', 'is', pId]);
        });

        return aFilters;
    }

    /**
     * Builds a bulk fallback map of deploymentId -> sandbox internal ID using
     * a single search (1 governance unit) instead of per-item lookups.
     *
     * @param {Object} pSearch - N/search module
     * @param {Array} pDeployments
     * @returns {Object} Map of scriptid -> internal ID
     */
    function buildFallbackMapV2(pSearch, pDeployments) {

        const oMap = {};
        const aScriptIds = pDeployments
            .map((pDep) => pDep.deploymentId)
            .filter((pId) => !!pId);

        if (aScriptIds.length === 0) {
            return oMap;
        }

        pSearch.create({
            type: 'scriptdeployment',
            filters: [
                ['script.isinactive', 'is', 'F'],
                'AND',
                ['isdeployed', 'is', 'T'],
                'AND',
                buildScriptIdFilters(aScriptIds)
            ],
            columns: [pSearch.createColumn({name: 'scriptid'})]
        }).run().each((pResult) => {

            oMap[pResult.getValue('scriptid')] = pResult.id;
            return true;
        });

        return oMap;
    }

    /**
     * Applies scheduled status using SuiteScript 2.x N/record with bulk
     * script ID fallback map (single search, not per-item).
     *
     * @param {Array} pDeployments
     */
    function applyV2(pDeployments) {

        try {

            require(['N/record', 'N/search'], (pRecord, pSearch) => {

                let oFallbackMap = {};

                try {
                    oFallbackMap = buildFallbackMapV2(pSearch, pDeployments);
                } catch (ignore) {
                    /* fallback map build failed, proceed without it */
                }

                const aResults = [];
                let iIndex = 0;

                function processNext() {

                    if (iIndex >= pDeployments.length) {
                        postResult('SCHEDULER_APPLY_RESULT', aResults, null);
                        return;
                    }

                    const oDep = pDeployments[iIndex];
                    let oItemResult;

                    try {

                        pRecord.submitFields({
                            type: 'scriptdeployment',
                            id: oDep.internalId,
                            values: {status: 'SCHEDULED'}
                        });

                        oItemResult = {
                            internalId: oDep.internalId,
                            deploymentId: oDep.deploymentId,
                            title: oDep.title,
                            scriptName: oDep.scriptName,
                            success: true
                        };

                    } catch (e) {

                        const sResolvedId = oDep.deploymentId ? oFallbackMap[oDep.deploymentId] : null;

                        if (sResolvedId && String(sResolvedId) !== String(oDep.internalId)) {

                            try {

                                pRecord.submitFields({
                                    type: 'scriptdeployment',
                                    id: sResolvedId,
                                    values: {status: 'SCHEDULED'}
                                });

                                oItemResult = {
                                    originalInternalId: oDep.internalId,
                                    internalId: sResolvedId,
                                    deploymentId: oDep.deploymentId,
                                    title: oDep.title,
                                    scriptName: oDep.scriptName,
                                    success: true,
                                    fallback: true
                                };

                            } catch (e2) {
                                oItemResult = {
                                    originalInternalId: oDep.internalId,
                                    internalId: oDep.internalId,
                                    deploymentId: oDep.deploymentId,
                                    title: oDep.title,
                                    scriptName: oDep.scriptName,
                                    success: false,
                                    error: safeErrorMessage(e2)
                                };
                            }

                        } else {
                            oItemResult = {
                                internalId: oDep.internalId,
                                deploymentId: oDep.deploymentId,
                                title: oDep.title,
                                scriptName: oDep.scriptName,
                                success: false,
                                error: safeErrorMessage(e)
                            };
                        }
                    }

                    aResults.push(oItemResult);
                    postResult('SCHEDULER_APPLY_PROGRESS', oItemResult, null);
                    iIndex++;
                    setTimeout(processNext, 0);
                }

                processNext();
            });

        } catch (e) {
            postResult('SCHEDULER_APPLY_RESULT', null, safeErrorMessage(e));
        }
    }

    /**
     * Builds a bulk fallback map of deploymentId -> sandbox internal ID using
     * a single nlapiSearchRecord call (1 governance unit).
     *
     * @param {Array} pDeployments
     * @returns {Object} Map of scriptid -> internal ID
     */
    function buildFallbackMapV1(pDeployments) {

        const oMap = {};
        const aScriptIds = pDeployments
            .map((pDep) => pDep.deploymentId)
            .filter((pId) => !!pId);

        if (aScriptIds.length === 0) {
            return oMap;
        }

        const oResults = nlapiSearchRecord('scriptdeployment', null,
            [
                ['script.isinactive', 'is', 'F'],
                'AND',
                ['isdeployed', 'is', 'T'],
                'AND',
                buildScriptIdFilters(aScriptIds)
            ],
            [new nlobjSearchColumn('scriptid')]
        );

        if (oResults) {

            oResults.forEach((pResult) => {

                oMap[pResult.getValue('scriptid')] = pResult.getId();
            });
        }

        return oMap;
    }

    /**
     * Applies scheduled status using SuiteScript 1.0 nlapiSubmitField with bulk
     * script ID fallback map (single search, not per-item).
     *
     * @param {Array} pDeployments
     */
    function applyV1(pDeployments) {

        let oFallbackMap = {};

        try {
            oFallbackMap = buildFallbackMapV1(pDeployments);
        } catch (ignore) {
            /* fallback map build failed, proceed without it */
        }

        const aResults = [];
        let iIndex = 0;

        function processNext() {

            if (iIndex >= pDeployments.length) {
                postResult('SCHEDULER_APPLY_RESULT', aResults, null);
                return;
            }

            const oDep = pDeployments[iIndex];
            let oItemResult;

            try {

                nlapiSubmitField('scriptdeployment', oDep.internalId, 'status', 'SCHEDULED');

                oItemResult = {
                    internalId: oDep.internalId,
                    deploymentId: oDep.deploymentId,
                    title: oDep.title,
                    scriptName: oDep.scriptName,
                    success: true
                };

            } catch (e) {

                const sResolvedId = oDep.deploymentId ? oFallbackMap[oDep.deploymentId] : null;

                if (sResolvedId && String(sResolvedId) !== String(oDep.internalId)) {

                    try {

                        nlapiSubmitField('scriptdeployment', sResolvedId, 'status', 'SCHEDULED');

                        oItemResult = {
                            originalInternalId: oDep.internalId,
                            internalId: sResolvedId,
                            deploymentId: oDep.deploymentId,
                            title: oDep.title,
                            scriptName: oDep.scriptName,
                            success: true,
                            fallback: true
                        };

                    } catch (e2) {
                        oItemResult = {
                            originalInternalId: oDep.internalId,
                            internalId: oDep.internalId,
                            deploymentId: oDep.deploymentId,
                            title: oDep.title,
                            scriptName: oDep.scriptName,
                            success: false,
                            error: safeErrorMessage(e2)
                        };
                    }

                } else {
                    oItemResult = {
                        internalId: oDep.internalId,
                        deploymentId: oDep.deploymentId,
                        title: oDep.title,
                        scriptName: oDep.scriptName,
                        success: false,
                        error: safeErrorMessage(e)
                    };
                }
            }

            aResults.push(oItemResult);
            postResult('SCHEDULER_APPLY_PROGRESS', oItemResult, null);
            iIndex++;
            setTimeout(processNext, 0);
        }

        processNext();
    }

    /* ----------------------------------------------------------------
     * Shared — post result back to content script
     * ---------------------------------------------------------------- */

    /**
     * Posts a result message back to the content script via window.postMessage.
     *
     * @param {string} pType - Message type identifier
     * @param {*} pData - Result data
     * @param {string|null} pError - Error message or null
     */
    function postResult(pType, pData, pError) {

        window.postMessage({
            type: pType,
            error: pError,
            data: pData
        }, window.location.origin);
    }

})();
