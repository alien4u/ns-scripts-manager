import {describe, expect, test} from 'bun:test';
import {
    ORIGIN,
    FakeSearchColumn,
    createCurrentRecordModule,
    createQueryModule,
    createRequire,
    createResultV1,
    createResultV2,
    createSearchModule,
    runPageScript
} from './fakes.js';

/* ── Synthetic fixtures ── */

/**
 * Builds a deployment row as N/query asMappedResults() returns it (checkboxes are booleans).
 *
 * @param {number} pId
 * @param {string} pStatus
 * @param {boolean} pDeployed
 * @param {boolean} pInactive
 * @returns {Object}
 */
const makeScriptRow = (pId, pStatus, pDeployed, pInactive) => ({
    ID: pId,
    SCRIPT: pId + 90,
    DEPLOYMENT_ID: `customdeploy_t_${pId}`,
    STATUS: pStatus,
    DEPLOYED: pDeployed,
    SCRIPT_INACTIVE: pInactive
});

const oaScriptRowsV2 = [
    makeScriptRow(11, 'Released', true, false),
    makeScriptRow(12, 'Testing', true, false),
    makeScriptRow(13, 'Released', false, false),
    makeScriptRow(14, 'Released', true, true),
    makeScriptRow(15, 'Testing', false, true),
    makeScriptRow(16, 'Not Scheduled', true, false),
    makeScriptRow(17, '', true, false)
];

const oExpectedScriptStates = {
    11: 'active',
    12: 'testing',
    13: 'undeployed',
    14: 'script_inactive',
    15: 'script_inactive',
    16: 'not_released',
    17: 'not_released'
};

/* Same deployments as SS 1.0 nlobjSearchResult rows ('T'/'F' checkboxes) */
const oaScriptResultsV1 = oaScriptRowsV2.map((pRow) => createResultV1(String(pRow.ID), {
    'script': String(pRow.SCRIPT),
    'scriptid': pRow.DEPLOYMENT_ID,
    'status': pRow.STATUS.toUpperCase().replace(' ', ''),
    'isdeployed': pRow.DEPLOYED ? 'T' : 'F',
    'script.isinactive': pRow.SCRIPT_INACTIVE ? 'T' : 'F',
    'script.name': `Synthetic ${pRow.ID}`
}, {
    'status': pRow.STATUS,
    'script.scripttype': 'User Event'
}));

/* Workflows: [internal id, release status value, release status text, isinactive] */
const aWorkflowDefs = [
    ['21', 'RELEASED', 'Released', true],
    ['22', 'TESTING', 'Testing', false],
    ['23', 'RELEASED', 'Released', false],
    ['24', 'NOTINITIATING', '', false],
    ['25', 'SUSPENDED', 'Suspended', false]
];

const oExpectedWorkflowStates = {
    21: 'inactive',
    22: 'testing',
    23: 'active',
    24: 'not_released',
    25: 'not_released'
};

const oaWorkflowResultsV2 = aWorkflowDefs.map(([pId, pValue, pText, pInactive]) => createResultV2(pId, {
    internalid: pId,
    name: `Synthetic Workflow ${pId}`,
    description: '',
    releasestatus: pValue,
    isinactive: pInactive
}, {releasestatus: pText}));

const oaWorkflowResultsV1 = aWorkflowDefs.map(([pId, pValue, pText, pInactive]) => createResultV1(pId, {
    name: `Synthetic Workflow ${pId}`,
    description: '',
    releasestatus: pValue,
    isinactive: pInactive ? 'T' : 'F'
}, {releasestatus: pText}));

/* ── Runners ── */

/**
 * Runs nsmain.js on the SS 2.x path.
 *
 * @param {Object} pOptions - {record, lookupFields, scriptRows, workflowResults, getPreference, role, document,
 *     globals (extra page globals such as nlapi*)}
 * @returns {Array}
 */
const runV2 = (pOptions) => {

    const oSearch = createSearchModule(
        (pType) => (pType === 'workflow' ? (pOptions.workflowResults || []) : []),
        pOptions.lookupFields
    );

    return runPageScript('nsmain', {
        ...(pOptions.globals || {}),
        ...(pOptions.document ? {document: pOptions.document} : {}),
        require: createRequire({
            'N/query': createQueryModule(pOptions.scriptRows || []),
            'N/search': oSearch,
            'N/util': {extend: (pTarget, pSource) => Object.assign(pTarget, pSource)},
            'N/currentRecord': createCurrentRecordModule(pOptions.record),
            'N/runtime': {
                getCurrentUser: () => ({
                    role: pOptions.role,
                    getPreference: pOptions.getPreference || (() => undefined)
                })
            }
        })
    });
};

/**
 * Runs nsmain.js on the SS 1.0 path (no require on the page).
 *
 * @param {Object} pGlobals - nlapi* overrides
 * @returns {Array}
 */
const runV1 = (pGlobals) => {

    return runPageScript('nsmain', {
        nlobjSearchColumn: FakeSearchColumn,
        nlapiSearchRecord: (pType) => {

            if (pType === 'scriptdeployment') {
                return oaScriptResultsV1;
            }

            return pType === 'workflow' ? oaWorkflowResultsV1 : null;
        },
        nlapiGetRecordType: () => 'salesorder',
        nlapiGetFieldValue: () => '',
        nlapiGetRecordId: () => '',
        nlapiLookupField: () => '',
        nlapiGetContext: () => ({getPreference: () => null}),
        ...pGlobals
    });
};

/**
 * Builds an N/currentRecord record double.
 *
 * @param {string} pType
 * @param {*} pId
 * @param {Function} [pGetValue]
 * @returns {Object}
 */
const makeRecord = (pType, pId, pGetValue) => ({type: pType, id: pId, getValue: pGetValue || (() => undefined)});

/**
 * Returns the single SCRIPTS_DATA message posted by nsmain.js.
 *
 * @param {Array} pPosted
 * @returns {Object}
 */
const onlyMessage = (pPosted) => {

    expect(pPosted).toHaveLength(1);
    expect(pPosted[0].targetOrigin).toBe(ORIGIN);
    expect(pPosted[0].message.type).toBe('SCRIPTS_DATA');
    return pPosted[0].message;
};

/**
 * Maps rows to {id: STATE}.
 *
 * @param {Array} pRows
 * @param {string} pIdKey
 * @returns {Object}
 */
const statesById = (pRows, pIdKey) => Object.fromEntries(pRows.map((pRow) => [String(pRow[pIdKey]), pRow.STATE]));

/* ── Tests ── */

describe('nsmain.js script STATE', () => {

    test('SS 2.x: every STATE branch from boolean checkboxes', () => {

        const oMessage = onlyMessage(runV2({record: makeRecord('salesorder', 7), scriptRows: oaScriptRowsV2}));
        const aScripts = oMessage.data.SCRIPTS_DATA;

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.API_VERSION).toBe('2.x');
        expect(statesById(aScripts, 'ID')).toEqual(oExpectedScriptStates);

        const oNotScheduled = aScripts.find((pRow) => pRow.ID === 16);
        expect(oNotScheduled.DEPLOYED).toBe(true);
        expect(aScripts.find((pRow) => pRow.ID === 13).DEPLOYED).toBe(false);
        expect(aScripts.find((pRow) => pRow.ID === 14).INACTIVE).toBe(true);
    });

    test('SS 2.x: DEPLOYMENT_URL points at the deployment record', () => {

        const oMessage = onlyMessage(runV2({record: makeRecord('salesorder', 7), scriptRows: oaScriptRowsV2}));
        const oRow = oMessage.data.SCRIPTS_DATA.find((pRow) => pRow.ID === 11);

        expect(oRow.DEPLOYMENT_ID).toBe('customdeploy_t_11');
        expect(oRow.DEPLOYMENT_URL).toBe(`${ORIGIN}/app/common/scripting/scriptrecord.nl?id=11`);
    });

    test('SS 1.0: every STATE branch from T/F checkboxes', () => {

        const oMessage = onlyMessage(runV1({}));
        const aScripts = oMessage.data.SCRIPTS_DATA;

        expect(oMessage.data.API_VERSION).toBe('1.0');
        expect(statesById(aScripts, 'ID')).toEqual(oExpectedScriptStates);
        expect(aScripts.find((pRow) => pRow.ID === '16').DEPLOYED).toBe(true);
        expect(aScripts.find((pRow) => pRow.ID === '13').DEPLOYED).toBe(false);
        expect(aScripts.find((pRow) => pRow.ID === '14').INACTIVE).toBe(true);
        expect(aScripts.find((pRow) => pRow.ID === '12').DEPLOYMENT_URL)
            .toBe(`${ORIGIN}/app/common/scripting/scriptrecord.nl?id=12`);
    });
});

describe('nsmain.js workflow STATE', () => {

    test('SS 2.x: inactive / testing / released / not released', () => {

        const oMessage = onlyMessage(runV2({
            record: makeRecord('salesorder', 7),
            workflowResults: oaWorkflowResultsV2
        }));
        const aWorkflows = oMessage.data.WORKFLOWS_DATA;

        expect(statesById(aWorkflows, 'WORKFLOW')).toEqual(oExpectedWorkflowStates);
        expect(aWorkflows.find((pRow) => pRow.WORKFLOW === '21').INACTIVE).toBe(true);
        expect(aWorkflows.find((pRow) => pRow.WORKFLOW === '21').STATUS).toBe('Released');
        expect(aWorkflows.find((pRow) => pRow.WORKFLOW === '24').STATUS).toBe('Not Initiating');
    });

    test('SS 1.0: inactive / testing / released / not released', () => {

        const oMessage = onlyMessage(runV1({}));
        const aWorkflows = oMessage.data.WORKFLOWS_DATA;

        expect(statesById(aWorkflows, 'WORKFLOW')).toEqual(oExpectedWorkflowStates);
        expect(aWorkflows.find((pRow) => pRow.WORKFLOW === '21').INACTIVE).toBe(true);
        expect(aWorkflows.find((pRow) => pRow.WORKFLOW === '23').INACTIVE).toBe(false);
    });
});

describe('nsmain.js record detection', () => {

    test('SS 2.x: no record type posts NO_RECORD', () => {

        const oMessage = onlyMessage(runV2({record: makeRecord('', undefined)}));

        expect(oMessage.error).toBe('NO_RECORD');
        expect(oMessage.data).toBeUndefined();
    });

    test('SS 2.x: generic record posts GENERIC_RECORD', () => {

        const oMessage = onlyMessage(runV2({record: makeRecord('generic', 3)}));

        expect(oMessage.error).toBe('GENERIC_RECORD');
        expect(oMessage.message).toBe('Generic records are not scriptable!');
    });

    test('SS 1.0: no record type posts NO_RECORD', () => {

        const oMessage = onlyMessage(runV1({nlapiGetRecordType: () => ''}));

        expect(oMessage.error).toBe('NO_RECORD');
    });

    test('SS 1.0: generic record posts GENERIC_RECORD', () => {

        const oMessage = onlyMessage(runV1({nlapiGetRecordType: () => 'generic'}));

        expect(oMessage.error).toBe('GENERIC_RECORD');
    });
});

describe('nsmain.js CUSTOM_FORM_ID', () => {

    test('SS 2.x: taken from currentRecord.getValue without a lookup', () => {

        let nLookups = 0;
        const oRecord = makeRecord('salesorder', 7, (pOptions) => (pOptions.fieldId === 'customform' ? '42' : ''));
        const oMessage = onlyMessage(runV2({
            record: oRecord,
            lookupFields: () => {

                nLookups++;
                return {customform: [{value: '99', text: 'Synthetic'}]};
            }
        }));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('42');
        expect(nLookups).toBe(0);
    });

    test('SS 2.x: view mode falls back to search.lookupFields', () => {

        let oLookupArgs = null;
        const oMessage = onlyMessage(runV2({
            record: makeRecord('salesorder', 7),
            lookupFields: (pOptions) => {

                oLookupArgs = pOptions;
                return {customform: [{value: '55', text: 'Synthetic Form'}]};
            }
        }));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('55');
        expect(JSON.parse(JSON.stringify(oLookupArgs))).toEqual({type: 'salesorder', id: '7', columns: ['customform']});
    });

    test('SS 2.x: lookupFields bare {value, text} shape', () => {

        const oMessage = onlyMessage(runV2({
            record: makeRecord('salesorder', 7),
            lookupFields: () => ({customform: {value: '56', text: 'Synthetic Form'}})
        }));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('56');
    });

    test('SS 2.x: getValue and lookupFields failures yield empty string', () => {

        const oRecord = makeRecord('salesorder', 7, () => {

            throw new Error('field not available');
        });
        const oMessage = onlyMessage(runV2({
            record: oRecord,
            lookupFields: () => {

                throw new Error('lookup failed');
            }
        }));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.CUSTOM_FORM_ID).toBe('');
    });

    test('SS 2.x: no record id (create mode, field empty) skips the lookup', () => {

        const oMessage = onlyMessage(runV2({record: makeRecord('salesorder', null, () => '')}));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('');
    });

    test('SS 1.0: taken from nlapiGetFieldValue', () => {

        const oMessage = onlyMessage(runV1({nlapiGetFieldValue: (pField) => (pField === 'customform' ? '42' : '')}));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('42');
    });

    test('SS 1.0: view mode falls back to nlapiLookupField', () => {

        let aLookupArgs = null;
        const oMessage = onlyMessage(runV1({
            nlapiGetRecordId: () => '7',
            nlapiLookupField: (...pArgs) => {

                aLookupArgs = pArgs;
                return '55';
            }
        }));

        expect(oMessage.data.CUSTOM_FORM_ID).toBe('55');
        expect(aLookupArgs).toEqual(['salesorder', '7', 'customform']);
    });

    test('SS 1.0: lookup failures yield empty string', () => {

        const fnThrow = () => {

            throw new Error('not available');
        };
        const oMessage = onlyMessage(runV1({
            nlapiGetFieldValue: fnThrow,
            nlapiGetRecordId: fnThrow,
            nlapiLookupField: fnThrow
        }));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.CUSTOM_FORM_ID).toBe('');
    });
});

describe('nsmain.js CLIENT_LIMIT_REMOVED (REMOVECLIENTGOVERNANCELIMIT)', () => {

    const sPreference = 'REMOVECLIENTGOVERNANCELIMIT';

    /**
     * SS 2.x run with a getPreference double; records the requested preference name.
     *
     * @param {Function} pGetPreference - Returns the raw value or throws
     * @returns {{value: *, names: string[]}}
     */
    const runPreferenceV2 = (pGetPreference) => {

        const aNames = [];
        const oMessage = onlyMessage(runV2({
            record: makeRecord('salesorder', 7),
            getPreference: (pOptions) => {

                aNames.push(pOptions.name);
                return pGetPreference();
            }
        }));

        return {value: oMessage.data.CLIENT_LIMIT_REMOVED, names: aNames};
    };

    /**
     * SS 1.0 run with an nlapiGetContext().getPreference double.
     *
     * @param {Function} pGetPreference - Returns the raw value or throws
     * @returns {{value: *, names: string[]}}
     */
    const runPreferenceV1 = (pGetPreference) => {

        const aNames = [];
        const oMessage = onlyMessage(runV1({
            nlapiGetContext: () => ({
                getPreference: (pName) => {

                    aNames.push(pName);
                    return pGetPreference();
                }
            })
        }));

        return {value: oMessage.data.CLIENT_LIMIT_REMOVED, names: aNames};
    };

    const fnThrow = () => {

        throw new Error('preference not readable');
    };

    test.each([
        ['true (limit removed)', () => true, true],
        ['false (limit in force)', () => false, false],
        ['undefined (unknown preference)', () => undefined, null],
        ['null', () => null, null],
        ['empty string', () => '', null],
        ['exception', fnThrow, null]
    ])('SS 2.x getPreference %s', (pLabel, pGetPreference, pExpected) => {

        const oResult = runPreferenceV2(pGetPreference);

        expect(oResult.value).toBe(pExpected);
        expect(oResult.names).toEqual([sPreference]);
    });

    test('SS 2.x getCurrentUser failure yields null', () => {

        const oMessage = onlyMessage(runPageScript('nsmain', {
            require: createRequire({
                'N/query': createQueryModule([]),
                'N/search': createSearchModule(() => []),
                'N/util': {extend: (pTarget, pSource) => Object.assign(pTarget, pSource)},
                'N/currentRecord': createCurrentRecordModule(makeRecord('salesorder', 7)),
                'N/runtime': {getCurrentUser: fnThrow}
            })
        }));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.CLIENT_LIMIT_REMOVED).toBeNull();
    });

    test.each([
        ["'T' (limit removed)", () => 'T', true],
        ["'F' (limit in force)", () => 'F', false],
        ['null (unknown preference)', () => null, null],
        ['undefined', () => undefined, null],
        ['empty string', () => '', null],
        ['exception', fnThrow, null]
    ])('SS 1.0 getPreference %s', (pLabel, pGetPreference, pExpected) => {

        const oResult = runPreferenceV1(pGetPreference);

        expect(oResult.value).toBe(pExpected);
        expect(oResult.names).toEqual([sPreference]);
    });

    test('SS 1.0 without nlapiGetContext yields null', () => {

        const oMessage = onlyMessage(runV1({nlapiGetContext: undefined}));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.CLIENT_LIMIT_REMOVED).toBeNull();
    });
});

describe('nsmain.js popup cache request (request id, cache keys, ROLE_ID, light payload)', () => {

    /**
     * Page document holding the request element content.js writes; counts removals.
     *
     * @param {string} pRequestId
     * @param {string} pCacheKeys - Raw data-cache-keys value
     * @returns {{document: Object, removed: () => number}}
     */
    const makeRequestDocument = (pRequestId, pCacheKeys) => {

        let nRemoved = 0;
        const oElement = {
            dataset: {requestId: pRequestId, cacheKeys: pCacheKeys},
            remove: () => {

                nRemoved++;
            }
        };

        return {
            document: {getElementById: (pId) => (pId === '__ns_sm_main_data__' && nRemoved === 0 ? oElement : null)},
            removed: () => nRemoved
        };
    };

    /**
     * SS 2.x run counting N/query and N/search create() calls.
     *
     * @param {Object} pOptions - {document, role}
     * @returns {{message: Object, queries: number, searches: number}}
     */
    const runCountedV2 = (pOptions) => {

        let nQueries = 0;
        let nSearches = 0;
        const oQuery = createQueryModule(oaScriptRowsV2);
        const oSearch = createSearchModule((pType) => (pType === 'workflow' ? oaWorkflowResultsV2 : []));
        const fnQueryCreate = oQuery.create;
        const fnSearchCreate = oSearch.create;

        oQuery.create = (pArg) => {

            nQueries++;
            return fnQueryCreate(pArg);
        };
        oSearch.create = (pArg) => {

            nSearches++;
            return fnSearchCreate(pArg);
        };

        const aPosted = runPageScript('nsmain', {
            document: pOptions.document,
            require: createRequire({
                'N/query': oQuery,
                'N/search': oSearch,
                'N/util': {extend: (pTarget, pSource) => Object.assign(pTarget, pSource)},
                'N/currentRecord': createCurrentRecordModule(makeRecord('salesorder', 7, () => '42')),
                'N/runtime': {getCurrentUser: () => ({role: pOptions.role, getPreference: () => false})}
            })
        });

        return {message: onlyMessage(aPosted), queries: nQueries, searches: nSearches};
    };

    test('SS 2.x: matching role|TYPE -> light payload, no N/query or N/search calls, element removed', () => {

        const oRequest = makeRequestDocument('req-1', JSON.stringify(['3|SALESORDER', '3|INVOICE']));
        const oResult = runCountedV2({document: oRequest.document, role: 3});

        expect(oRequest.removed()).toBe(1);
        expect(oResult.message.requestId).toBe('req-1');
        expect(oResult.message.error).toBeNull();
        expect(oResult.message.data).toEqual({
            FROM_CACHE: true,
            RECORD_TYPE: 'salesorder',
            ROLE_ID: '3',
            CUSTOM_FORM_ID: '42',
            CLIENT_LIMIT_REMOVED: false,
            API_VERSION: '2.x'
        });
        expect(oResult.queries).toBe(0);
        expect(oResult.searches).toBe(0);
    });

    test('SS 2.x: keys for another role or type -> full payload with ROLE_ID', () => {

        const oRequest = makeRequestDocument('req-2', JSON.stringify(['1018|SALESORDER', '3|INVOICE']));
        const oResult = runCountedV2({document: oRequest.document, role: 3});
        const oData = oResult.message.data;

        expect(oResult.message.requestId).toBe('req-2');
        expect(oData.FROM_CACHE).toBeUndefined();
        expect(oData.ROLE_ID).toBe('3');
        expect(oData.SCRIPTS_DATA).toHaveLength(oaScriptRowsV2.length);
        expect(oData.WORKFLOWS_DATA).toHaveLength(oaWorkflowResultsV2.length);
        expect(oResult.queries).toBe(1);
        expect(oResult.searches).toBe(1);
    });

    test('SS 2.x: force (no keys) and no request element -> full payload', () => {

        const oForced = runCountedV2({document: makeRequestDocument('req-3', '[]').document, role: 3});
        const oNoElement = runCountedV2({document: {getElementById: () => null}, role: 3});

        expect(oForced.message.requestId).toBe('req-3');
        expect(oForced.message.data.SCRIPTS_DATA).toHaveLength(oaScriptRowsV2.length);
        expect(oNoElement.message.requestId).toBe('');
        expect(oNoElement.message.data.SCRIPTS_DATA).toHaveLength(oaScriptRowsV2.length);
        expect(oNoElement.message.data.ROLE_ID).toBe('3');
    });

    test('SS 2.x: unknown role never takes the light path; malformed keys -> full payload', () => {

        const oNoRole = runCountedV2({document: makeRequestDocument('req-4', '["|SALESORDER"]').document});
        const oBadKeys = runCountedV2({document: makeRequestDocument('req-5', '{not json').document, role: 3});

        expect(oNoRole.message.data.ROLE_ID).toBe('');
        expect(oNoRole.message.data.FROM_CACHE).toBeUndefined();
        expect(oNoRole.queries).toBe(1);
        expect(oBadKeys.message.data.FROM_CACHE).toBeUndefined();
        expect(oBadKeys.queries).toBe(1);
    });

    test('Error payloads echo the request id', () => {

        const oRequest = makeRequestDocument('req-6', '[]');
        const oMessage = onlyMessage(runV2({record: makeRecord('', undefined), document: oRequest.document}));

        expect(oMessage.error).toBe('NO_RECORD');
        expect(oMessage.requestId).toBe('req-6');
    });

    test('SS 1.0: matching role|TYPE -> light payload, nlapiSearchRecord not called', () => {

        let nSearches = 0;
        const oRequest = makeRequestDocument('req-7', JSON.stringify(['1018|SALESORDER']));
        const oMessage = onlyMessage(runV1({
            document: oRequest.document,
            nlapiGetContext: () => ({getRole: () => '1018', getPreference: () => 'F'}),
            nlapiGetFieldValue: () => '42',
            nlapiSearchRecord: () => {

                nSearches++;
                return null;
            }
        }));

        expect(oRequest.removed()).toBe(1);
        expect(oMessage.requestId).toBe('req-7');
        expect(oMessage.data).toEqual({
            FROM_CACHE: true,
            RECORD_TYPE: 'salesorder',
            ROLE_ID: '1018',
            CUSTOM_FORM_ID: '42',
            CLIENT_LIMIT_REMOVED: false,
            API_VERSION: '1.0'
        });
        expect(nSearches).toBe(0);
    });

    test('SS 1.0: no matching key -> full payload with ROLE_ID from nlapiGetContext().getRole()', () => {

        const oMessage = onlyMessage(runV1({
            document: makeRequestDocument('req-8', JSON.stringify(['3|SALESORDER'])).document,
            nlapiGetContext: () => ({getRole: () => '1018', getPreference: () => null})
        }));

        expect(oMessage.requestId).toBe('req-8');
        expect(oMessage.data.FROM_CACHE).toBeUndefined();
        expect(oMessage.data.ROLE_ID).toBe('1018');
        expect(oMessage.data.SCRIPTS_DATA).toHaveLength(oaScriptRowsV2.length);
    });
});

describe('nsmain.js empty N/currentRecord record (type/id null) falls back to SS 1.0', () => {

    /* What N/currentRecord.get() returned on a live Sales Order: no exception, no type, no id */
    const oEmptyRecord = {type: null, id: null, getValue: () => undefined};

    test('view mode: RECORD_TYPE from nlapiGetRecordType, form looked up with nlapiGetRecordId', () => {

        let oLookupArgs = null;
        const oMessage = onlyMessage(runV2({
            record: oEmptyRecord,
            scriptRows: oaScriptRowsV2,
            globals: {
                nlapiGetRecordType: () => 'salesorder',
                nlapiGetRecordId: () => '7'
            },
            lookupFields: (pOptions) => {

                oLookupArgs = pOptions;
                return {customform: [{value: '55', text: 'Synthetic Form'}]};
            }
        }));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.RECORD_TYPE).toBe('salesorder');
        expect(oMessage.data.API_VERSION).toBe('2.x');
        expect(oMessage.data.SCRIPTS_DATA).toHaveLength(oaScriptRowsV2.length);
        expect(oMessage.data.CUSTOM_FORM_ID).toBe('55');
        expect(JSON.parse(JSON.stringify(oLookupArgs))).toEqual({type: 'salesorder', id: '7', columns: ['customform']});
    });

    test('create mode (no id anywhere): form from nlapiGetFieldValue, no lookup', () => {

        let nLookups = 0;
        const oMessage = onlyMessage(runV2({
            record: {...oEmptyRecord, type: ''},
            globals: {
                nlapiGetRecordType: () => 'salesorder',
                nlapiGetRecordId: () => '',
                nlapiGetFieldValue: (pField) => (pField === 'customform' ? '42' : '')
            },
            lookupFields: () => {

                nLookups++;
                return {customform: [{value: '99'}]};
            }
        }));

        expect(oMessage.error).toBeNull();
        expect(oMessage.data.RECORD_TYPE).toBe('salesorder');
        expect(oMessage.data.CUSTOM_FORM_ID).toBe('42');
        expect(nLookups).toBe(0);
    });

    test('empty record and no SS 1.0 record type: still NO_RECORD', () => {

        const oMessage = onlyMessage(runV2({record: oEmptyRecord}));

        expect(oMessage.error).toBe('NO_RECORD');
    });
});
