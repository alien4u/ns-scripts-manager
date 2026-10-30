/**
 * Test doubles for the page-context scripts (js/nsmain.js, js/nsscheduler.js).
 *
 * The real source files run unmodified inside a node:vm context. Globals they expect
 * from a NetSuite page (window, require, nlapi*, document) are faked here. All data is
 * synthetic.
 */

import {readFileSync} from 'node:fs';
import vm from 'node:vm';

export const ORIGIN = 'https://harness.app.netsuite.com';

const oSources = {
    nsmain: readFileSync(new URL('../js/nsmain.js', import.meta.url), 'utf8'),
    nsscheduler: readFileSync(new URL('../js/nsscheduler.js', import.meta.url), 'utf8')
};

/**
 * Runs a page-context script once in a fresh vm context.
 * Timers are inert: the 2.x fakes call back synchronously, so the failsafe never matters.
 *
 * @param {string} pName - 'nsmain' | 'nsscheduler'
 * @param {Object} pGlobals - Extra globals (require, nlapi*, document); document defaults to an empty page
 * @returns {Array<{message: Object, targetOrigin: string}>} Messages posted to window
 */
export const runPageScript = (pName, pGlobals) => {

    const aPosted = [];
    const oWindow = {
        location: {origin: ORIGIN},
        postMessage: (pMessage, pTargetOrigin) => {

            /* JSON round trip moves the payload out of the vm realm */
            aPosted.push({message: JSON.parse(JSON.stringify(pMessage)), targetOrigin: pTargetOrigin});
        }
    };

    const oContext = vm.createContext({
        window: oWindow,
        document: {getElementById: () => null},
        setTimeout: () => 0,
        clearTimeout: () => {},
        ...pGlobals
    });

    vm.runInContext(oSources[pName], oContext, {filename: `js/${pName}.js`});

    return aPosted;
};

/**
 * AMD require double that resolves N/* modules synchronously.
 *
 * @param {Object} pModules - Map of module id to fake module
 * @returns {Function}
 */
export const createRequire = (pModules) => {

    return (pDeps, pCallback) => {

        pCallback(...pDeps.map((pDep) => pModules[pDep]));
    };
};

/**
 * N/query double. asMappedResults returns copies of the given rows (already keyed by alias).
 *
 * @param {Array<Object>} pRows
 * @returns {Object}
 */
export const createQueryModule = (pRows) => {

    const createLevel = () => {

        return {
            createColumn: (pOptions) => ({alias: pOptions.alias}),
            createSort: (pOptions) => pOptions,
            joinTo: () => createLevel(),
            autoJoin: () => createLevel()
        };
    };

    return {
        Type: {SCRIPT_DEPLOYMENT: 'scriptdeployment'},
        Operator: {ANY_OF: 'ANY_OF'},
        create: () => {

            const oQuery = createLevel();
            oQuery.and = (...pConditions) => pConditions;
            oQuery.createCondition = (pOptions) => pOptions;
            oQuery.run = () => ({asMappedResults: () => pRows.map((pRow) => ({...pRow}))});
            return oQuery;
        }
    };
};

/**
 * Key used by the result doubles: 'name' or 'join.name'.
 *
 * @param {string} pName
 * @param {string} [pJoin]
 * @returns {string}
 */
const columnKey = (pName, pJoin) => (pJoin ? `${pJoin}.${pName}` : pName);

/**
 * N/search Result double (2.x): getValue/getText accept a column name or {name, join}.
 *
 * @param {string} pId
 * @param {Object} pValues - Keyed by columnKey
 * @param {Object} [pTexts] - Keyed by columnKey
 * @returns {Object}
 */
export const createResultV2 = (pId, pValues, pTexts = {}) => {

    const getKey = (pColumn) => (typeof pColumn === 'string' ? pColumn : columnKey(pColumn.name, pColumn.join));

    return {
        id: pId,
        getValue: (pColumn) => pValues[getKey(pColumn)],
        getText: (pColumn) => pTexts[getKey(pColumn)]
    };
};

/**
 * nlobjSearchResult double (1.0): getValue(name, join) / getText(name, join) / getId().
 *
 * @param {string} pId
 * @param {Object} pValues - Keyed by columnKey
 * @param {Object} [pTexts] - Keyed by columnKey
 * @returns {Object}
 */
export const createResultV1 = (pId, pValues, pTexts = {}) => {

    return {
        getId: () => pId,
        getValue: (pName, pJoin) => pValues[columnKey(pName, pJoin)],
        getText: (pName, pJoin) => pTexts[columnKey(pName, pJoin)]
    };
};

/**
 * N/search double. pGetResults(type, filters) supplies the rows for each search.
 *
 * @param {Function} pGetResults
 * @param {Function} [pLookupFields]
 * @returns {Object}
 */
export const createSearchModule = (pGetResults, pLookupFields) => {

    return {
        Operator: {ANYOF: 'anyof'},
        Sort: {ASC: 'ASC'},
        createFilter: (pFilter) => pFilter,
        createColumn: (pColumn) => pColumn,
        lookupFields: pLookupFields || (() => {

            throw new Error('lookupFields not expected');
        }),
        create: (pOptions) => {

            return {
                run: () => ({
                    each: (pCallback) => {

                        for (const oResult of pGetResults(pOptions.type, pOptions.filters)) {
                            if (pCallback(oResult) === false) {
                                break;
                            }
                        }
                    }
                })
            };
        }
    };
};

/**
 * nlobjSearchColumn double (constructed with `new`).
 */
export class FakeSearchColumn {

    constructor(pName, pJoin) {

        this.name = pName;
        this.join = pJoin;
    }

    setSort() {

        return this;
    }
}

/**
 * N/currentRecord double.
 *
 * @param {Object} pRecord - {type, id, getValue}
 * @returns {Object}
 */
export const createCurrentRecordModule = (pRecord) => {

    return {get: () => pRecord};
};
