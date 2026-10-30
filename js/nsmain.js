(() => {

    const sBaseScriptRecordUrl = `${window.location.origin}/app/common/scripting/script.nl?id=`;
    const sBaseDeploymentUrl = `${window.location.origin}/app/common/scripting/scriptrecord.nl?id=`;
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

    /**
     * Derives the run state of a script deployment or workflow.
     * Precedence: inactive, Deployed checkbox unchecked (scripts only), then status.
     *
     * @param {string} pInactiveState - State returned when pInactive is true
     * @param {boolean} pInactive - script.isinactive or workflow isinactive
     * @param {boolean} pDeployed - Deployment isdeployed (always true for workflows)
     * @param {string} pStatus - Status display text
     * @returns {string} pInactiveState | undeployed | active | testing | not_released
     */
    const getRunState = (pInactiveState, pInactive, pDeployed, pStatus) => {

        if (pInactive) {
            return pInactiveState;
        }

        if (!pDeployed) {
            return 'undeployed';
        }

        const sStatus = (pStatus || '').toLowerCase();

        if (sStatus === 'released') {
            return 'active';
        }

        if (sStatus === 'testing') {
            return 'testing';
        }

        return 'not_released';
    };

    /**
     * Resolves the current record's custom form id. Create/edit mode exposes the field on the
     * page; view mode does not, so the value is looked up by record id.
     *
     * @param {string} pRecordType
     * @param {Object} [pCurrentRecord] - N/currentRecord module (SS 2.x path)
     * @param {Object} [pSearch] - N/search module (SS 2.x path)
     * @returns {string} Form internal id, '' when unknown
     */
    const getCustomFormId = (pRecordType, pCurrentRecord, pSearch) => {

        let sFormId = '';
        let sRecordId = '';

        if (pCurrentRecord) {

            try {
                const oCurrRec = pCurrentRecord.get();
                sRecordId = oCurrRec.id ? String(oCurrRec.id) : '';
                sFormId = oCurrRec.getValue({fieldId: 'customform'}) || '';
            } catch (e) {
                /* Field not available on this page */
            }

            if (!sFormId && sRecordId) {
                try {
                    const oLookup = pSearch.lookupFields({type: pRecordType, id: sRecordId, columns: ['customform']});
                    /* Select fields return [{value, text}]; the docs also show a bare {value, text} */
                    const oForm = Array.isArray(oLookup.customform) ? oLookup.customform[0] : oLookup.customform;
                    sFormId = (oForm && oForm.value) || '';
                } catch (e) {
                    /* Lookup failed, form unknown */
                }
            }

            return String(sFormId);
        }

        try {
            sFormId = nlapiGetFieldValue('customform') || '';
        } catch (e) {
            /* Field not available on this page */
        }

        if (!sFormId) {
            try {
                sRecordId = nlapiGetRecordId() || '';

                if (sRecordId) {
                    sFormId = nlapiLookupField(pRecordType, sRecordId, 'customform') || '';
                }
            } catch (e) {
                /* Lookup failed, form unknown */
            }
        }

        return String(sFormId);
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

        /**
         * Builds query columns from oColumnsMap, sets sort order, and executes the query.
         *
         * @returns {Array} Query result rows
         */
        const buildAndRun = () => {

            oQueryObj.columns = [...Object.keys(oColumnsMap).map((pColumn) => {
                return oColumnsMap[pColumn].LEVEL.createColumn(pUtil.extend(oColumnsMap[pColumn].COLUMN, {alias: pColumn}));
            })];

            oQueryObj.sort = [
                oScriptJoin.createSort({
                    column: oQueryObj.columns.find((pCol) => pCol.alias === 'SCRIPT_NAME'),
                    ascending: true
                })
            ];

            return oQueryObj.run().asMappedResults() || [];
        };

        let aResults;

        try {
            aResults = buildAndRun();
        } catch (e) {

            if (String(e).indexOf('hideinbundle') !== -1) {
                delete oColumnsMap.FILE_HIDE_IN_BUNDLE;
                aResults = buildAndRun();
            } else {
                throw e;
            }
        }

        aResults.forEach((pData) => {

            pData.INACTIVE = toBoolean(pData.SCRIPT_INACTIVE);
            pData.DEPLOYED = toBoolean(pData.DEPLOYED);
            pData.STATE = getRunState('script_inactive', pData.INACTIVE, pData.DEPLOYED, pData.STATUS);

            pData.URL = `${sBaseScriptRecordUrl}${pData.SCRIPT}&whence=`;
            pData.DEPLOYMENT_URL = `${sBaseDeploymentUrl}${pData.ID}`;
            pData.FILE_URL = `${sBaseEditFileUrl.replace('_FILE_ID_', pData.SCRIPT_FILE)}`;
            pData.INFO = buildInfo(pData.API_VERSION, pData.DESCRIPTION, pData.SCRIPT_FILE_NAME);
            pData.HIDE_IN_BUNDLE = toBoolean(pData.FILE_HIDE_IN_BUNDLE);
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
            STATUS: {name: 'releasestatus'},
            INACTIVE: {name: 'isinactive'}
        };
        const aColumns = [...Object.keys(oColumnsMap).map((pColumn) => pSearch.createColumn(oColumnsMap[pColumn]))];

        const aWorkflowsData = [];

        pSearch.create({
            type: 'workflow',
            filters: aFilters,
            columns: aColumns
        }).run().each((pResult) => {

            const oData = Object.keys(oColumnsMap).reduce((pAccumulator, pColumn) => {

                pAccumulator[pColumn] = pResult.getValue(oColumnsMap[pColumn]);
                return pAccumulator;
            }, {});

            oData.STATUS = normalizeWorkflowStatus(
                pResult.getText(oColumnsMap.STATUS) || pResult.getValue(oColumnsMap.STATUS)
            );
            oData.INACTIVE = toBoolean(oData.INACTIVE);
            oData.STATE = getRunState('inactive', oData.INACTIVE, true, oData.STATUS);

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

        oSearchResults.forEach((pResult) => {

            const sDeploymentId = pResult.getId();
            const sScriptId = pResult.getValue('script');
            const sFileId = pResult.getValue('scriptfile', 'script');
            const sStatus = pResult.getText('status') || pResult.getValue('status') || '';
            const bDeployed = toBoolean(pResult.getValue('isdeployed'));
            const bScriptInactive = toBoolean(pResult.getValue('isinactive', 'script'));

            aResults.push({
                ID: sDeploymentId,
                SCRIPT: sScriptId,
                DEPLOYMENT_ID: pResult.getValue('scriptid'),
                SCRIPT_NAME: pResult.getValue('name', 'script') || '',
                SCRIPT_TYPE: pResult.getText('scripttype', 'script') || pResult.getValue('scripttype', 'script') || 'Unknown',
                DEPLOYED: bDeployed,
                STATUS: sStatus,
                INACTIVE: bScriptInactive,
                STATE: getRunState('script_inactive', bScriptInactive, bDeployed, sStatus),
                DEPLOYMENT_URL: `${sBaseDeploymentUrl}${sDeploymentId}`,
                API_VERSION: pResult.getText('apiversion', 'script') || pResult.getValue('apiversion', 'script') || '',
                DESCRIPTION: pResult.getValue('description', 'script') || '',
                SCRIPT_FILE: sFileId,
                SCRIPT_FILE_NAME: pResult.getText('scriptfile', 'script') || '',
                URL: `${sBaseScriptRecordUrl}${sScriptId}&whence=`,
                FILE_URL: `${sBaseEditFileUrl.replace('_FILE_ID_', sFileId)}`,
                INFO: buildInfo(
                    pResult.getText('apiversion', 'script') || pResult.getValue('apiversion', 'script'),
                    pResult.getValue('description', 'script'),
                    pResult.getText('scriptfile', 'script')
                ),
                HIDE_IN_BUNDLE: false,
                BEFORE_LOAD_FN: pResult.getValue('beforeloadfunction', 'script') || '',
                BEFORE_SUBMIT_FN: pResult.getValue('beforesubmitfunction', 'script') || '',
                AFTER_SUBMIT_FN: pResult.getValue('aftersubmitfunction', 'script') || '',
                PAGE_INIT_FN: pResult.getValue('pageinitfunction', 'script') || '',
                FIELD_CHANGED_FN: pResult.getValue('fieldchangedfunction', 'script') || '',
                SAVE_RECORD_FN: pResult.getValue('saverecordfunction', 'script') || '',
                VALIDATE_FIELD_FN: pResult.getValue('validatefieldfunction', 'script') || ''
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
                    new nlobjSearchColumn('releasestatus'),
                    new nlobjSearchColumn('isinactive')
                ]
            );
        } catch (e) {
            return {error: e.message, data: []};
        }

        if (!oSearchResults) {
            return {error: null, data: []};
        }

        oSearchResults.forEach((pResult) => {

            const sWorkflowId = pResult.getId();
            const sStatus = normalizeWorkflowStatus(
                pResult.getText('releasestatus') || pResult.getValue('releasestatus')
            );
            const bInactive = toBoolean(pResult.getValue('isinactive'));

            aResults.push({
                WORKFLOW: sWorkflowId,
                WORKFLOW_NAME: pResult.getValue('name') || '',
                DESCRIPTION: pResult.getValue('description') || '',
                STATUS: sStatus,
                INACTIVE: bInactive,
                STATE: getRunState('inactive', bInactive, true, sStatus),
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
                error: (!sRecordType) ? 'NO_RECORD' : 'GENERIC_RECORD',
                message: (!sRecordType)
                    ? 'Unable to detect the record type on this page.'
                    : 'Generic records are not scriptable!'
            }, window.location.origin);

            return;
        }

        const oScriptsResult = getScriptsDataV1(sRecordType);
        const oWorkflowsResult = getWorkflowsDataV1(sRecordType);
        const sCustomFormId = getCustomFormId(sRecordType);

        window.postMessage({
            type: 'SCRIPTS_DATA',
            error: null,
            data: {
                SCRIPTS_DATA: oScriptsResult.data,
                WORKFLOWS_DATA: oWorkflowsResult.data,
                SCRIPT_ERROR: oScriptsResult.error || '',
                WORKFLOW_ERROR: oWorkflowsResult.error || '',
                RECORD_TYPE: sRecordType,
                CUSTOM_FORM_ID: sCustomFormId,
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
        const nFailSafeTimeout = setTimeout(() => {

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

                    clearTimeout(nFailSafeTimeout);

                    const sRecordType = getRecordType(pCurrentRecord);

                    if (!sRecordType || sRecordType.toLowerCase() === 'generic') {

                        window.postMessage({
                            type: 'SCRIPTS_DATA',
                            error: (!sRecordType) ? 'NO_RECORD' : 'GENERIC_RECORD',
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

                    const sCustomFormId = getCustomFormId(sRecordType, pCurrentRecord, pSearch);

                    window.postMessage({
                        type: 'SCRIPTS_DATA',
                        error: null,
                        data: {
                            SCRIPTS_DATA: aScriptsData,
                            WORKFLOWS_DATA: aWorkflowsData,
                            SCRIPT_ERROR: sScriptError,
                            WORKFLOW_ERROR: sWorkflowError,
                            RECORD_TYPE: sRecordType,
                            CUSTOM_FORM_ID: sCustomFormId,
                            API_VERSION: '2.x'
                        }
                    }, window.location.origin);
                },
                (pError) => {

                    if (bDidFail) {
                        return;
                    }

                    clearTimeout(nFailSafeTimeout);
                    bDidFail = true;

                    /* Attempt SS 1.0 fallback */
                    if (bHasNlapi) {
                        executeSS1Fallback();
                    } else {
                        window.postMessage({
                            type: 'SCRIPTS_DATA',
                            error: 'MODULES_LOAD_FAILED',
                            message: pError.message || 'Unknown error loading NetSuite modules.'
                        }, window.location.origin);
                    }
                });

        } catch (oError) {

            if (!bDidFail) {

                clearTimeout(nFailSafeTimeout);
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
