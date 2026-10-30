/**
 * Static server for the popup harness. Serves the repo root with CORS, loopback only.
 *
 * Usage (from anywhere):
 *   bun tests/browser/serve.js [port]      default port 8765, or PORT=xxxx
 * Then open:
 *   http://127.0.0.1:<port>/tests/browser/popup-harness.html?scenario=record
 */

import {resolve, sep} from 'node:path';

const sRoot = resolve(import.meta.dir, '../..');
const sHost = '127.0.0.1';
const nPort = Number(process.argv[2] || process.env.PORT || 8765);
const sHarnessPath = '/tests/browser/popup-harness.html';
const oHeaders = {'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'};

const oServer = Bun.serve({
    hostname: sHost,
    port: nPort,
    fetch: async (pRequest) => {

        const oUrl = new URL(pRequest.url);

        if (oUrl.pathname === '/') {
            return Response.redirect(sHarnessPath, 302);
        }

        const sPath = resolve(sRoot, '.' + decodeURIComponent(oUrl.pathname));

        if (sPath !== sRoot && !sPath.startsWith(sRoot + sep)) {
            return new Response('Forbidden', {status: 403, headers: oHeaders});
        }

        const oFile = Bun.file(sPath);

        if (!(await oFile.exists())) {
            return new Response('Not found', {status: 404, headers: oHeaders});
        }

        return new Response(oFile, {headers: oHeaders});
    }
});

console.log(`Popup harness: http://${sHost}:${oServer.port}${sHarnessPath}`);
console.log('Scenarios: record, unknown-form, forms-only, create-mode, no-record, no-api, deployed-filter, slow-forms');
