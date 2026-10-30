import {describe, expect, test} from 'bun:test';
import {
    ORIGIN,
    FakeSearchColumn,
    createRequire,
    createResultV1,
    createResultV2,
    createSearchModule,
    runPageScript
} from './fakes.js';

/* ── Synthetic fixtures ── */

/* Stored (production) deployments sent with the check command */
const oaStoredDeployments = [
    {internalId: '201', deploymentId: 'customdeploy_s_inactive'},
    {internalId: '202', deploymentId: 'customdeploy_s_undeployed'},
    {internalId: '203', deploymentId: 'customdeploy_s_scheduled'},
    {internalId: '204', deploymentId: 'customdeploy_s_not_scheduled'},
    {internalId: '901', deploymentId: 'customdeploy_s_fb_undeployed'},
    {internalId: '902', deploymentId: 'customdeploy_s_fb_inactive'},
    {internalId: '903', deploymentId: 'customdeploy_s_fb_status'}
];

/* Deployments in the checked account; 3xx ids differ from production, so 90x resolve by scriptid */
const oaAccountDeployments = [
    ['201', 'customdeploy_s_inactive', 'SCHEDULED', true, true],
    ['202', 'customdeploy_s_undeployed', 'SCHEDULED', false, false],
    ['203', 'customdeploy_s_scheduled', 'SCHEDULED', true, false],
    ['204', 'customdeploy_s_not_scheduled', 'NOTSCHEDULED', true, false],
    ['301', 'customdeploy_s_fb_undeployed', 'NOTSCHEDULED', false, false],
    ['302', 'customdeploy_s_fb_inactive', 'NOTSCHEDULED', true, true],
    ['303', 'customdeploy_s_fb_status', 'NOTSCHEDULED', true, false]
].map(([pId, pScriptId, pStatus, pDeployed, pInactive]) => ({
    internalId: pId,
    scriptid: pScriptId,
    status: pStatus,
    isdeployed: pDeployed,
    inactive: pInactive
}));

const oExpectedStatusMap = {
    201: 'INACTIVE_SCRIPT',
    202: 'UNDEPLOYED',
    203: 'SCHEDULED',
    204: 'NOTSCHEDULED',
    901: 'UNDEPLOYED',
    902: 'INACTIVE_SCRIPT',
    903: 'NOTSCHEDULED'
};

/**
 * Evaluates the two filter shapes the check command builds:
 * [['internalid', 'anyof', ids]] and [['scriptid', 'is', id], 'OR', ...].
 *
 * @param {Array} pFilters
 * @returns {Array<Object>} Matching account deployments
 */
const findDeployments = (pFilters) => {

    const aTerms = pFilters.filter((pTerm) => Array.isArray(pTerm));

    return oaAccountDeployments.filter((pRow) => aTerms.some((pTerm) => {

        if (pTerm[0] === 'internalid') {
            return pTerm[2].map(String).includes(pRow.internalId);
        }

        return pTerm[0] === 'scriptid' && pTerm[2] === pRow.scriptid;
    }));
};

/**
 * Fake DOM element that nsscheduler.js reads its command from.
 *
 * @param {string} pCommand
 * @param {Array} pDeployments
 * @returns {Object} document double
 */
const createDocument = (pCommand, pDeployments) => {

    const oDataEl = {
        dataset: {command: pCommand, deployments: JSON.stringify(pDeployments)},
        remove: () => {}
    };

    return {getElementById: (pId) => (pId === '__ns_scheduler_data__' ? oDataEl : null)};
};

/**
 * Returns the single SCHEDULER_CHECK_RESULT message.
 *
 * @param {Array} pPosted
 * @returns {Object}
 */
const onlyCheckResult = (pPosted) => {

    expect(pPosted).toHaveLength(1);
    expect(pPosted[0].targetOrigin).toBe(ORIGIN);
    expect(pPosted[0].message.type).toBe('SCHEDULER_CHECK_RESULT');
    expect(pPosted[0].message.error).toBeNull();
    return pPosted[0].message.data;
};

/* ── Tests ── */

describe('nsscheduler.js check', () => {

    test('SS 2.x: boolean checkboxes report INACTIVE_SCRIPT / UNDEPLOYED / status, incl. scriptid fallback', () => {

        const oSearch = createSearchModule((pType, pFilters) => findDeployments(pFilters).map((pRow) => createResultV2(
            pRow.internalId,
            {
                'scriptid': pRow.scriptid,
                'status': pRow.status,
                'isdeployed': pRow.isdeployed,
                'script.isinactive': pRow.inactive
            }
        )));

        const oStatusMap = onlyCheckResult(runPageScript('nsscheduler', {
            document: createDocument('check', oaStoredDeployments),
            require: createRequire({'N/search': oSearch})
        }));

        expect(oStatusMap).toEqual(oExpectedStatusMap);
    });

    test('SS 1.0: T/F checkboxes report INACTIVE_SCRIPT / UNDEPLOYED / status, incl. scriptid fallback', () => {

        const oStatusMap = onlyCheckResult(runPageScript('nsscheduler', {
            document: createDocument('check', oaStoredDeployments),
            nlobjSearchColumn: FakeSearchColumn,
            nlapiSearchRecord: (pType, pId, pFilters) => {

                const aRows = findDeployments(pFilters);

                return aRows.length === 0 ? null : aRows.map((pRow) => createResultV1(pRow.internalId, {
                    'scriptid': pRow.scriptid,
                    'status': pRow.status,
                    'isdeployed': pRow.isdeployed ? 'T' : 'F',
                    'script.isinactive': pRow.inactive ? 'T' : 'F'
                }));
            }
        }));

        expect(oStatusMap).toEqual(oExpectedStatusMap);
    });
});
