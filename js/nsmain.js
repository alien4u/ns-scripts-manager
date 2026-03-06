(() => {

    const sBaseScriptRecordUrl = `${window.location.origin}/app/common/scripting/script.nl?id=`;
    const sBaseEditFileUrl = `${window.location.origin}/app/common/record/edittextmediaitem.nl?id=_FILE_ID_&e=T&l=T&target=filesize&syntaxHighlighting=T`;
    const sBaseWorkflowsUrl = `${window.location.origin}/app/common/workflow/setup/workflowmanager.nl?id=`;

    /**
     * Builds the Info Data
     *
     * @param {string} pVersion
     * @param {string} pDescription
     * @param {string} pFileName
     * @returns {string}
     */
    const buildInfo = (pVersion, pDescription, pFileName) => {

        const aParts = [];
        if (pVersion) {
            aParts.push(`API Version: ${pVersion.toString().trim()}`);
        }
        if (pDescription) {
            aParts.push(`Description: ${pDescription.toString().trim()}`);
        }
        if (pFileName) {
            aParts.push(`File: ${pFileName.toString().trim()}`);
        }

        return aParts.join('\n') || 'N/A';
    };

    /**
     * Normalizes a NetSuite checkbox value to a boolean.
     *
     * @param {*} pValue - Raw checkbox value
     * @return {boolean}
     */
    const toBoolean = (pValue) => {

        if (typeof pValue === 'boolean') {
            return pValue;
        }

        if (typeof pValue === 'string') {
            return pValue.toUpperCase() === 'T' || pValue.toLowerCase() === 'yes';
        }

        return !!pValue;
    };

    /* ────────────────────────────────────────────────
     * SuiteScript 2.x Approach (N/query + N/search)
     * ──────────────────────────────────────────────── */

    /**
     * Fetches script data using SuiteScript 2.x N/query.
     *
     * @param {Object} pQuery
     * @param {Object} pUtil
     * @param {string} pRecordType
     * @returns {Array}
     */
    const getScriptsDataV2 = (pQuery, pUtil, pRecordType) => {

        const oQueryObj = pQuery.create({type: pQuery.Type.SCRIPT_DEPLOYMENT});
        const oScriptJoin = oQueryObj.joinTo({fieldId: "script", target: "script"});
        const oScriptFileJoin = oScriptJoin.autoJoin({fieldId: "scriptfile"});

        oQueryObj.condition = oQueryObj.and(
            oQueryObj.createCondition({
                fieldId: 'recordtype',
                operator: pQuery.Operator.ANY_OF,
                values: [pRecordType.toUpperCase()]
            }),
        );

        const oColumnsMap = {
            ID: {LEVEL: oQueryObj, COLUMN: {fieldId: 'primarykey'}},
            SCRIPT: {LEVEL: oQueryObj, COLUMN: {fieldId: 'script', context: {name: "RAW"}}},
            DEPLOYMENT_ID: {LEVEL: oQueryObj, COLUMN: {fieldId: 'scriptid'}},
            SCRIPT_NAME: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'name'}, SORT: { ascending: true }},
            SCRIPT_TYPE: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'scripttype', context: {name: "DISPLAY"}}},
            DEPLOYED: {LEVEL: oQueryObj, COLUMN: {fieldId: 'isdeployed'}},
            RECORD_TYPE: {LEVEL: oQueryObj, COLUMN: {fieldId: 'recordtype'}},
            STATUS: {LEVEL: oQueryObj, COLUMN: {fieldId: 'status', context: {name: "DISPLAY"}}},
            SCRIPT_INACTIVE: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'isinactive'}},
            API_VERSION: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'apiversion', context: {name: "DISPLAY"}}},
            DESCRIPTION: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'description'}},
            SCRIPT_FILE: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'scriptfile', context: {name: "RAW"}}},
            SCRIPT_FILE_NAME: {LEVEL: oScriptFileJoin, COLUMN: {fieldId: 'name'}},
            BEFORE_LOAD_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'beforeloadfunction'}},
            BEFORE_SUBMIT_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'beforesubmitfunction'}},
            AFTER_SUBMIT_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'aftersubmitfunction'}},
            PAGE_INIT_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'pageinitfunction'}},
            FIELD_CHANGED_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'fieldchangedfunction'}},
            SAVE_RECORD_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'saverecordfunction'}},
            VALIDATE_FIELD_FN: {LEVEL: oScriptJoin, COLUMN: {fieldId: 'validatefieldfunction'}},
            FILE_HIDE_IN_BUNDLE: {LEVEL: oScriptFileJoin, COLUMN: {fieldId: 'hideinbundle'}},
        };

        const buildAndRun = (pColumnsMap) => {

            oQueryObj.columns = [...Object.keys(pColumnsMap).map((sColumn) => {
                return pColumnsMap[sColumn].LEVEL.createColumn(pUtil.extend(pColumnsMap[sColumn].COLUMN, {alias: sColumn}));
            })];

            oQueryObj.sort = [
                oScriptJoin.createSort({
                    column: oQueryObj.columns.find((oCol) => oCol.alias === 'SCRIPT_NAME'),
                    ascending: true
                })
            ];

            return oQueryObj.run().asMappedResults() || [];
        };

        let aResults;

        try {
            aResults = buildAndRun(oColumnsMap);
        } catch (e) {

            if (String(e).indexOf('hideinbundle') !== -1) {
                delete oColumnsMap.FILE_HIDE_IN_BUNDLE;
                aResults = buildAndRun(oColumnsMap);
            } else {
                throw e;
            }
        }

        aResults.forEach((oData) => {

            oData.INACTIVE = toBoolean(oData.SCRIPT_INACTIVE);

            const sStatus = (oData.STATUS || '').toLowerCase();
            const bIsDeployed = toBoolean(oData.DEPLOYED);
            oData.DEPLOYED = bIsDeployed && (sStatus === 'released' || sStatus === 'testing');

            oData.URL = `${sBaseScriptRecordUrl}${oData.SCRIPT}&whence=`;
            oData.FILE_URL = `${sBaseEditFileUrl.replace('_FILE_ID_', oData.SCRIPT_FILE)}`;
            oData.INFO = buildInfo(oData.API_VERSION, oData.DESCRIPTION, oData.SCRIPT_FILE_NAME);
            oData.HIDE_IN_BUNDLE = toBoolean(oData.FILE_HIDE_IN_BUNDLE);
        });

        return aResults;
    };

    /**
     * Maps workflow release status internal values to display text.
     */
    const WORKFLOW_STATUS_MAP = {
        'RELEASED':      'Released',
        'TESTING':       'Testing',
        'NOTINITIATING': 'Not Initiating',
        'NOTRUNNING':    'Not Initiating',
        'SUSPENDED':     'Suspended',
        '1':             'Not Initiating',
        '2':             'Released',
        '3':             'Testing',
        '4':             'Suspended'
    };

    /**
     * Normalizes workflow status.
     *
     * @param {string} pRawStatus
     * @returns {string}
     */
    const normalizeWorkflowStatus = (pRawStatus) => {

        if (!pRawStatus) {
            return 'Unknown';
        }

        const sUpper = pRawStatus.toString().trim().toUpperCase();

        if (WORKFLOW_STATUS_MAP[sUpper]) {
            return WORKFLOW_STATUS_MAP[sUpper];
        }

        return pRawStatus.toString().trim();
    };

    /**
     * Fetches workflow data using SuiteScript 2.x N/search.
     *
     * @param {Object} pSearch
     * @param {string} pRecordType
     * @returns {Array}
     */
    const getWorkflowsDataV2 = (pSearch, pRecordType) => {

        const aFilters = [];
        aFilters.push(
            pSearch.createFilter({
                name: 'subrecordtype',
                operator: pSearch.Operator.ANYOF,
                values: [pRecordType.toUpperCase()]
            })
        );

        const oColumnsMap = {
            WORKFLOW: {name: 'internalid'},
            WORKFLOW_NAME: {name: 'name', sort: pSearch.Sort.ASC},
            DESCRIPTION: {name: 'description'},
            STATUS: {name: 'releasestatus'}
        };
        const aColumns = [...Object.keys(oColumnsMap).map((sColumn) => pSearch.createColumn(oColumnsMap[sColumn]))];

        const aWorkflowsData = [];

        pSearch.create({
            type: 'workflow',
            filters: aFilters,
            columns: aColumns
        }).run().each((oResult) => {

            const oData = Object.keys(oColumnsMap).reduce((oAccumulator, sColumn) => {

                oAccumulator[sColumn] = oResult.getValue(oColumnsMap[sColumn]);
                return oAccumulator;
            }, {});

            oData.STATUS = normalizeWorkflowStatus(
                oResult.getText(oColumnsMap.STATUS) || oResult.getValue(oColumnsMap.STATUS)
            );

            oData.URL = `${sBaseWorkflowsUrl}${oData.WORKFLOW}`;
            oData.EDIT_URL = `${sBaseWorkflowsUrl}${oData.WORKFLOW}&e=T`;

            aWorkflowsData.push(oData);

            return true;
        });

        return aWorkflowsData;
    };

    /* ────────────────────────────────────────────────
     * SuiteScript 1.0 Fallback (nlapiSearchRecord)
     * ──────────────────────────────────────────────── */

    /**
     * Fetches script data using SuiteScript 1.0 nlapiSearchRecord.
     *
     * @param {string} pRecordType
     * @returns {Object}
     */
    const getScriptsDataV1 = (pRecordType) => {

        const aResults = [];
        let oSearchResults;

        try {
            oSearchResults = nlapiSearchRecord('scriptdeployment', null,
                [
                    ['recordtype', 'anyof', pRecordType.toUpperCase()]
                ],
                [
                    new nlobjSearchColumn('internalid').setSort(false),
                    new nlobjSearchColumn('script'),
                    new nlobjSearchColumn('scriptid'),
                    new nlobjSearchColumn('name', 'script', null),
                    new nlobjSearchColumn('scripttype', 'script', null),
                    new nlobjSearchColumn('isdeployed'),
                    new nlobjSearchColumn('status'),
                    new nlobjSearchColumn('isinactive', 'script', null),
                    new nlobjSearchColumn('apiversion', 'script', null),
                    new nlobjSearchColumn('description', 'script', null),
                    new nlobjSearchColumn('scriptfile', 'script', null),
                    new nlobjSearchColumn('beforeloadfunction', 'script', null),
                    new nlobjSearchColumn('beforesubmitfunction', 'script', null),
                    new nlobjSearchColumn('aftersubmitfunction', 'script', null),
                    new nlobjSearchColumn('pageinitfunction', 'script', null),
                    new nlobjSearchColumn('fieldchangedfunction', 'script', null),
                    new nlobjSearchColumn('saverecordfunction', 'script', null),
                    new nlobjSearchColumn('validatefieldfunction', 'script', null)
                ]
            );
        } catch (e) {
            return {error: e.message, data: []};
        }

        if (!oSearchResults) {
            return {error: null, data: []};
        }

        oSearchResults.forEach((oResult) => {

            const sScriptId = oResult.getValue('script');
            const sFileId = oResult.getValue('scriptfile', 'script');
            const sStatus = (oResult.getText('status') || oResult.getValue('status') || '').toLowerCase();
            const bIsDeployed = oResult.getValue('isdeployed') === 'T';
            const bDeployed = bIsDeployed && (sStatus === 'released' || sStatus === 'testing');
            const bScriptInactive = oResult.getValue('isinactive', 'script') === 'T';

            aResults.push({
                ID: oResult.getId(),
                SCRIPT: sScriptId,
                DEPLOYMENT_ID: oResult.getValue('scriptid'),
                SCRIPT_NAME: oResult.getValue('name', 'script') || '',
                SCRIPT_TYPE: oResult.getText('scripttype', 'script') || oResult.getValue('scripttype', 'script') || 'Unknown',
                DEPLOYED: bDeployed,
                STATUS: oResult.getText('status') || oResult.getValue('status') || '',
                INACTIVE: bScriptInactive,
                API_VERSION: oResult.getText('apiversion', 'script') || oResult.getValue('apiversion', 'script') || '',
                DESCRIPTION: oResult.getValue('description', 'script') || '',
                SCRIPT_FILE: sFileId,
                SCRIPT_FILE_NAME: oResult.getText('scriptfile', 'script') || '',
                URL: `${sBaseScriptRecordUrl}${sScriptId}&whence=`,
                FILE_URL: `${sBaseEditFileUrl.replace('_FILE_ID_', sFileId)}`,
                INFO: buildInfo(
                    oResult.getText('apiversion', 'script') || oResult.getValue('apiversion', 'script'),
                    oResult.getValue('description', 'script'),
                    oResult.getText('scriptfile', 'script')
                ),
                HIDE_IN_BUNDLE: false,
                BEFORE_LOAD_FN: oResult.getValue('beforeloadfunction', 'script') || '',
                BEFORE_SUBMIT_FN: oResult.getValue('beforesubmitfunction', 'script') || '',
                AFTER_SUBMIT_FN: oResult.getValue('aftersubmitfunction', 'script') || '',
                PAGE_INIT_FN: oResult.getValue('pageinitfunction', 'script') || '',
                FIELD_CHANGED_FN: oResult.getValue('fieldchangedfunction', 'script') || '',
                SAVE_RECORD_FN: oResult.getValue('saverecordfunction', 'script') || '',
                VALIDATE_FIELD_FN: oResult.getValue('validatefieldfunction', 'script') || ''
            });
        });

        return {error: null, data: aResults};
    };

    /**
     * Fetches workflow data using SuiteScript 1.0 nlapiSearchRecord.
     *
     * @param {string} pRecordType
     * @returns {Object}
     */
    const getWorkflowsDataV1 = (pRecordType) => {

        const aResults = [];
        let oSearchResults;

        try {
            oSearchResults = nlapiSearchRecord('workflow', null,
                [
                    ['subrecordtype', 'anyof', pRecordType.toUpperCase()]
                ],
                [
                    new nlobjSearchColumn('internalid'),
                    new nlobjSearchColumn('name').setSort(false),
                    new nlobjSearchColumn('description'),
                    new nlobjSearchColumn('releasestatus')
                ]
            );
        } catch (e) {
            return {error: e.message, data: []};
        }

        if (!oSearchResults) {
            return {error: null, data: []};
        }

        oSearchResults.forEach((oResult) => {

            const sWorkflowId = oResult.getId();

            aResults.push({
                WORKFLOW: sWorkflowId,
                WORKFLOW_NAME: oResult.getValue('name') || '',
                DESCRIPTION: oResult.getValue('description') || '',
                STATUS: normalizeWorkflowStatus(
                    oResult.getText('releasestatus') || oResult.getValue('releasestatus')
                ),
                URL: `${sBaseWorkflowsUrl}${sWorkflowId}`,
                EDIT_URL: `${sBaseWorkflowsUrl}${sWorkflowId}&e=T`
            });
        });

        return {error: null, data: aResults};
    };

    /* ────────────────────────────────────────────────
     * Record Type Detection (cross-API)
     * ──────────────────────────────────────────────── */

    /**
     * Detects the record type of the current page.
     *
     * @param {Object} pCurrentRecord - Optional N/currentRecord module
     * @returns {string}
     */
    const getRecordType = (pCurrentRecord) => {

        /* Try SS 2.x N/currentRecord first */
        if (pCurrentRecord) {
            try {
                const oCurrRec = pCurrentRecord.get();
                return oCurrRec.type || '';
            } catch (e) {
                /* Fall through to SS 1.0 */
            }
        }

        /* Try SS 1.0 nlapiGetRecordType */
        if (typeof nlapiGetRecordType !== 'undefined') {
            try {
                return nlapiGetRecordType() || '';
            } catch (e) {
                /* Fall through */
            }
        }

        return '';
    };

    /**
     * Executes the full SS 1.0 fallback flow
     */
    const executeSS1Fallback = () => {

        let sRecordType = '';

        try {
            sRecordType = getRecordType(null);
        } catch (e) {
            /* ignore */
        }

        if (!sRecordType || sRecordType.toLowerCase() === 'generic') {

            window.postMessage({
                type: 'SCRIPTS_DATA',
                error: 'GENERIC_RECORD',
                message: (!sRecordType)
                    ? 'Unable to detect the record type on this page.'
                    : 'Generic records are not scriptable!'
            }, window.location.origin);

            return;
        }

        const oScriptsResult = getScriptsDataV1(sRecordType);
        const oWorkflowsResult = getWorkflowsDataV1(sRecordType);

        window.postMessage({
            type: 'SCRIPTS_DATA',
            error: null,
            data: {
                SCRIPTS_DATA: oScriptsResult.data,
                WORKFLOWS_DATA: oWorkflowsResult.data,
                SCRIPT_ERROR: oScriptsResult.error || '',
                WORKFLOW_ERROR: oWorkflowsResult.error || '',
                RECORD_TYPE: sRecordType,
                API_VERSION: '1.0'
            }
        }, window.location.origin);
    };

    /* ────────────────────────────────────────────────
     * Main Execution
     * ──────────────────────────────────────────────── */

    const bHasRequire = typeof require !== 'undefined';
    const bHasNlapi = typeof nlapiSearchRecord !== 'undefined';

    if (!bHasRequire && !bHasNlapi) {

        window.postMessage({
            type: 'SCRIPTS_DATA',
            error: 'NO_API_AVAILABLE',
            message: 'Neither SuiteScript 2.x (require) nor SuiteScript 1.0 (nlapi) is available on this page.'
        }, window.location.origin);

        return;
    }

    /* ── SS 2.x path ── */
    if (bHasRequire) {

        let bDidFail = false;
        const iFailSafeTimeout = setTimeout(() => {

            if (!bDidFail) {

                bDidFail = true;

                /* Attempt SS 1.0 fallback before giving up */
                if (bHasNlapi) {
                    executeSS1Fallback();
                } else {
                    window.postMessage({
                        type: 'SCRIPTS_DATA',
                        error: 'MODULES_LOAD_TIMEOUT',
                        message: 'Timeout loading N/* modules and SuiteScript 1.0 is not available on this page.'
                    }, window.location.origin);
                }
            }
        }, 1500);

        try {

            require(['N/query', 'N/search', 'N/util', 'N/currentRecord'],

                (pQuery, pSearch, pUtil, pCurrentRecord) => {

                    if (bDidFail) {
                        return;
                    }

                    clearTimeout(iFailSafeTimeout);

                    const sRecordType = getRecordType(pCurrentRecord);

                    if (!sRecordType || sRecordType.toLowerCase() === 'generic') {

                        window.postMessage({
                            type: 'SCRIPTS_DATA',
                            error: 'GENERIC_RECORD',
                            message: (!sRecordType)
                                ? 'Unable to detect the record type on this page.'
                                : 'Generic records are not scriptable!'
                        }, window.location.origin);

                        return;
                    }

                    let aScriptsData = [];
                    let sScriptError = '';
                    let aWorkflowsData = [];
                    let sWorkflowError = '';

                    try {
                        aScriptsData = getScriptsDataV2(pQuery, pUtil, sRecordType);
                    } catch (e) {
                        sScriptError = e.message || 'Error querying script deployments.';
                    }

                    try {
                        aWorkflowsData = getWorkflowsDataV2(pSearch, sRecordType);
                    } catch (e) {
                        sWorkflowError = e.message || 'Error querying workflows.';
                    }

                    window.postMessage({
                        type: 'SCRIPTS_DATA',
                        error: null,
                        data: {
                            SCRIPTS_DATA: aScriptsData,
                            WORKFLOWS_DATA: aWorkflowsData,
                            SCRIPT_ERROR: sScriptError,
                            WORKFLOW_ERROR: sWorkflowError,
                            RECORD_TYPE: sRecordType,
                            API_VERSION: '2.x'
                        }
                    }, window.location.origin);
                },
                (oError) => {

                    if (bDidFail) {
                        return;
                    }

                    clearTimeout(iFailSafeTimeout);
                    bDidFail = true;

                    /* Attempt SS 1.0 fallback */
                    if (bHasNlapi) {
                        executeSS1Fallback();
                    } else {
                        window.postMessage({
                            type: 'SCRIPTS_DATA',
                            error: 'MODULES_LOAD_FAILED',
                            message: oError.message || 'Unknown error loading NetSuite modules.'
                        }, window.location.origin);
                    }
                });

        } catch (oError) {

            if (!bDidFail) {

                clearTimeout(iFailSafeTimeout);
                bDidFail = true;

                if (bHasNlapi) {
                    executeSS1Fallback();
                } else {
                    window.postMessage({
                        type: 'SCRIPTS_DATA',
                        error: 'MODULES_LOAD_FAILED',
                        message: oError.message || 'Unexpected error in require block.'
                    }, window.location.origin);
                }
            }
        }

    } else {

        /* ── SS 1.0 only path ── */
        executeSS1Fallback();
    }

})();
