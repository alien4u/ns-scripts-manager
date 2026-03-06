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
                    }).run().each((oResult) => {

                        aResults.push({
                            internalId: oResult.id,
                            deploymentId: oResult.getValue('scriptid'),
                            title: oResult.getValue('title'),
                            scriptName: oResult.getText('script'),
                            scriptId: oResult.getValue({name: 'scriptid', join: 'script'})
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

                oSearchResults.forEach((oResult) => {

                    aResults.push({
                        internalId: oResult.getId(),
                        deploymentId: oResult.getValue('scriptid'),
                        title: oResult.getValue('title'),
                        scriptName: oResult.getText('script'),
                        scriptId: oResult.getValue('scriptid', 'script')
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
     * @param {Array} aDeployments
     */
    function checkDeploymentStatus(aDeployments) {

        if (!aDeployments || !aDeployments.length) {
            postResult('SCHEDULER_CHECK_RESULT', null, 'No deployments to check.');
            return;
        }

        const bHasRequire = typeof require !== 'undefined';
        const bHasNlapi = typeof nlapiSearchRecord !== 'undefined';

        if (bHasRequire) {
            checkV2(aDeployments);
        } else if (bHasNlapi) {
            checkV1(aDeployments);
        } else {
            postResult('SCHEDULER_CHECK_RESULT', null, 'Neither SuiteScript 2.x nor 1.0 is available on this page.');
        }
    }

    /**
     * Builds an internalid anyof filter from a list of deployments.
     *
     * @param {Array} aDeployments
     * @returns {Array}
     */
    function buildIdFilters(aDeployments) {

        return [['internalid', 'anyof', aDeployments.map((oDep) => oDep.internalId)]];
    }

    /**
     * Finds deployments not matched by internal ID and resolves them by scriptid.
     * Keys results by the original (production) internal ID so the popup can match.
     *
     * @param {Object} pSearch - N/search module
     * @param {Array} aDeployments
     * @param {Object} oStatusMap - Map already populated by internal ID search
     */
    function checkFallbackV2(pSearch, aDeployments, oStatusMap) {

        const aMissing = aDeployments.filter((oDep) =>
            oDep.deploymentId && !oStatusMap[oDep.internalId]
        );

        if (aMissing.length === 0) {
            return;
        }

        const oScriptIdToOrigId = {};

        aMissing.forEach((oDep) => {
            oScriptIdToOrigId[oDep.deploymentId] = oDep.internalId;
        });

        const aScriptIds = aMissing.map((oDep) => oDep.deploymentId);

        pSearch.create({
            type: 'scriptdeployment',
            filters: buildScriptIdFilters(aScriptIds),
            columns: [
                pSearch.createColumn({name: 'scriptid'}),
                pSearch.createColumn({name: 'status'}),
                pSearch.createColumn({name: 'isdeployed'}),
                pSearch.createColumn({name: 'isinactive', join: 'script'})
            ]
        }).run().each((oResult) => {

            const sScriptId = oResult.getValue('scriptid');
            const sOrigId = oScriptIdToOrigId[sScriptId];

            if (!sOrigId || oStatusMap[sOrigId]) {
                return true;
            }

            if (oResult.getValue({name: 'isinactive', join: 'script'}) === 'T') {
                oStatusMap[sOrigId] = 'INACTIVE_SCRIPT';
            } else if (oResult.getValue('isdeployed') === 'F') {
                oStatusMap[sOrigId] = 'UNDEPLOYED';
            } else if (oStatusMap[sOrigId] !== 'SCHEDULED') {
                oStatusMap[sOrigId] = oResult.getValue('status');
            }

            return true;
        });
    }

    /**
     * Checks deployment status using SuiteScript 2.x N/search.
     *
     * @param {Array} aDeployments
     */
    function checkV2(aDeployments) {

        try {

            require(['N/search'], (pSearch) => {

                try {

                    const oStatusMap = {};

                    pSearch.create({
                        type: 'scriptdeployment',
                        filters: buildIdFilters(aDeployments),
                        columns: [
                            pSearch.createColumn({name: 'status'}),
                            pSearch.createColumn({name: 'isdeployed'}),
                            pSearch.createColumn({name: 'isinactive', join: 'script'})
                        ]
                    }).run().each((oResult) => {

                        if (oResult.getValue({name: 'isinactive', join: 'script'}) === 'T') {
                            oStatusMap[oResult.id] = 'INACTIVE_SCRIPT';
                        } else if (oResult.getValue('isdeployed') === 'F') {
                            oStatusMap[oResult.id] = 'UNDEPLOYED';
                        } else {
                            oStatusMap[oResult.id] = oResult.getValue('status');
                        }
                        return true;
                    });

                    try {
                        checkFallbackV2(pSearch, aDeployments, oStatusMap);
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
     * @param {Array} aDeployments
     * @param {Object} oStatusMap - Map already populated by internal ID search
     */
    function checkFallbackV1(aDeployments, oStatusMap) {

        const aMissing = aDeployments.filter((oDep) =>
            oDep.deploymentId && !oStatusMap[oDep.internalId]
        );

        if (aMissing.length === 0) {
            return;
        }

        const oScriptIdToOrigId = {};

        aMissing.forEach((oDep) => {
            oScriptIdToOrigId[oDep.deploymentId] = oDep.internalId;
        });

        const aScriptIds = aMissing.map((oDep) => oDep.deploymentId);

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

            oResults.forEach((oResult) => {

                const sScriptId = oResult.getValue('scriptid');
                const sOrigId = oScriptIdToOrigId[sScriptId];

                if (!sOrigId || oStatusMap[sOrigId]) {
                    return;
                }

                if (oResult.getValue('isinactive', 'script') === 'T') {
                    oStatusMap[sOrigId] = 'INACTIVE_SCRIPT';
                } else if (oResult.getValue('isdeployed') === 'F') {
                    oStatusMap[sOrigId] = 'UNDEPLOYED';
                } else if (oStatusMap[sOrigId] !== 'SCHEDULED') {
                    oStatusMap[sOrigId] = oResult.getValue('status');
                }
            });
        }
    }

    /**
     * Checks deployment status using SuiteScript 1.0 nlapiSearchRecord.
     *
     * @param {Array} aDeployments
     */
    function checkV1(aDeployments) {

        try {

            const oStatusMap = {};

            const oSearchResults = nlapiSearchRecord('scriptdeployment', null,
                buildIdFilters(aDeployments),
                [
                    new nlobjSearchColumn('status'),
                    new nlobjSearchColumn('isdeployed'),
                    new nlobjSearchColumn('isinactive', 'script')
                ]
            );

            if (oSearchResults) {

                oSearchResults.forEach((oResult) => {

                    if (oResult.getValue('isinactive', 'script') === 'T') {
                        oStatusMap[oResult.getId()] = 'INACTIVE_SCRIPT';
                    } else if (oResult.getValue('isdeployed') === 'F') {
                        oStatusMap[oResult.getId()] = 'UNDEPLOYED';
                    } else {
                        oStatusMap[oResult.getId()] = oResult.getValue('status');
                    }
                });
            }

            try {
                checkFallbackV1(aDeployments, oStatusMap);
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
     * @param {Array} aDeployments
     */
    function applyScheduledDeployments(aDeployments) {

        if (!aDeployments || !aDeployments.length) {
            postResult('SCHEDULER_APPLY_RESULT', null, 'No deployments to apply.');
            return;
        }

        const bHasRequire = typeof require !== 'undefined';
        const bHasNlapi = typeof nlapiSubmitField !== 'undefined';

        if (bHasRequire) {
            applyV2(aDeployments);
        } else if (bHasNlapi) {
            applyV1(aDeployments);
        } else {
            postResult('SCHEDULER_APPLY_RESULT', null, 'Neither SuiteScript 2.x nor 1.0 is available on this page.');
        }
    }

    /**
     * Builds OR-chained scriptid filters for text field matching.
     * e.g. [['scriptid','is','id1'],'OR',['scriptid','is','id2'],...]
     *
     * @param {Array} aScriptIds
     * @returns {Array}
     */
    function buildScriptIdFilters(aScriptIds) {

        const aFilters = [];

        aScriptIds.forEach((sId, iIdx) => {

            if (iIdx > 0) {
                aFilters.push('OR');
            }

            aFilters.push(['scriptid', 'is', sId]);
        });

        return aFilters;
    }

    /**
     * Builds a bulk fallback map of deploymentId -> sandbox internal ID using
     * a single search (1 governance unit) instead of per-item lookups.
     *
     * @param {Object} pSearch - N/search module
     * @param {Array} aDeployments
     * @returns {Object} Map of scriptid -> internal ID
     */
    function buildFallbackMapV2(pSearch, aDeployments) {

        const oMap = {};
        const aScriptIds = aDeployments
            .map((oDep) => oDep.deploymentId)
            .filter((sId) => !!sId);

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
        }).run().each((oResult) => {

            oMap[oResult.getValue('scriptid')] = oResult.id;
            return true;
        });

        return oMap;
    }

    /**
     * Applies scheduled status using SuiteScript 2.x N/record with bulk
     * script ID fallback map (single search, not per-item).
     *
     * @param {Array} aDeployments
     */
    function applyV2(aDeployments) {

        try {

            require(['N/record', 'N/search'], (pRecord, pSearch) => {

                let oFallbackMap = {};

                try {
                    oFallbackMap = buildFallbackMapV2(pSearch, aDeployments);
                } catch (ignore) {
                    /* fallback map build failed, proceed without it */
                }

                const aResults = [];
                let iIndex = 0;

                function processNext() {

                    if (iIndex >= aDeployments.length) {
                        postResult('SCHEDULER_APPLY_RESULT', aResults, null);
                        return;
                    }

                    const oDep = aDeployments[iIndex];
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
     * @param {Array} aDeployments
     * @returns {Object} Map of scriptid -> internal ID
     */
    function buildFallbackMapV1(aDeployments) {

        const oMap = {};
        const aScriptIds = aDeployments
            .map((oDep) => oDep.deploymentId)
            .filter((sId) => !!sId);

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

            oResults.forEach((oResult) => {

                oMap[oResult.getValue('scriptid')] = oResult.getId();
            });
        }

        return oMap;
    }

    /**
     * Applies scheduled status using SuiteScript 1.0 nlapiSubmitField with bulk
     * script ID fallback map (single search, not per-item).
     *
     * @param {Array} aDeployments
     */
    function applyV1(aDeployments) {

        let oFallbackMap = {};

        try {
            oFallbackMap = buildFallbackMapV1(aDeployments);
        } catch (ignore) {
            /* fallback map build failed, proceed without it */
        }

        const aResults = [];
        let iIndex = 0;

        function processNext() {

            if (iIndex >= aDeployments.length) {
                postResult('SCHEDULER_APPLY_RESULT', aResults, null);
                return;
            }

            const oDep = aDeployments[iIndex];
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
     * @param {string} sType - Message type identifier
     * @param {*} pData - Result data
     * @param {string|null} pError - Error message or null
     */
    function postResult(sType, pData, pError) {

        window.postMessage({
            type: sType,
            error: pError,
            data: pData
        }, window.location.origin);
    }

})();
