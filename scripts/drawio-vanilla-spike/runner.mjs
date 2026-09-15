import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { readManifest, verifyAssets, parseArgs, MODES, sha256, verifyObservation } from './contract.mjs';
const args = parseArgs(process.argv.slice(2), ['--work-dir', '--output-dir', '--mode']);
assert(args['--work-dir'] && args['--output-dir'] && MODES.includes(args['--mode']), 'Require --work-dir, fresh --output-dir, and --mode: ' + MODES.join(', '));
const mode = args['--mode'];
const workDir = await fs.realpath(args['--work-dir']);
const outputDir = path.resolve(args['--output-dir']);
const root = path.join(workDir, 'assets');
const manifest = await readManifest();
await verifyAssets(workDir, manifest);
// Exclusive directory creation never replaces prior results or a caller's directory.
await fs.mkdir(outputDir, { mode: 0o700 });
const files = new Map(manifest.files.map(item => ['/' + item.path, item]));
const origins = { host: 'http://127.0.0.1:16631', editor: 'http://127.0.0.1:16632' };
const query = 'embed=1&proto=json&stealth=1&local=1&plugins=0&math=0&pwa=0&drafts=0&sync=none&lang=en&libraries=0&saveAndExit=1';
let xml = '<mxfile host="fixed-spike"><diagram id="fixed" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="SPIKE BEFORE" style="rounded=0;whiteSpace=wrap;html=0;" vertex="1" parent="1"><mxGeometry x="80" y="80" width="160" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
if (mode.includes('xml-negative')) xml=xml.replace('</root>', '<mxCell id="3" value="" style="shape=image;image=http://127.0.0.1:16633/__drawio_negative__-xml-image;" vertex="1" parent="1"><mxGeometry x="280" y="80" width="100" height="100" as="geometry"/></mxCell></root>');
const report = { mode, version: manifest.version, environment: { node: process.version, os: os.platform(), architecture: os.arch(), osRelease: os.release(), playwright: createRequire(import.meta.url)('@playwright/test/package.json').version }, origins, policy: '', events: [], console: [], errors: [], attempted: [], failed: [], routeBlocked: [], wire: [], missing: [], violations: [], result: 'unobserved' };
const csp = `default-src 'none'; script-src 'self'; style-src 'self'${mode.startsWith('baseline') ? '' : " 'unsafe-inline'"}; img-src 'self'${mode.startsWith('baseline') ? '' : ' data:'}; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; manifest-src 'none'`;
report.policy = csp;
const hostScript = `const frame=document.querySelector('iframe');window.spikeEvents=[];window.spikeRejected=[];window.spikeCandidates=[];let loaded=false;addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==${JSON.stringify(origins.editor)}||typeof e.data!=='string'||e.data.length>32768){window.spikeRejected.push('identity-or-bound');return;}let m;try{m=JSON.parse(e.data);}catch{return;}if(!m||typeof m.event!=='string')return;window.spikeEvents.push({event:m.event,keys:Object.keys(m),bytes:e.data.length,exit:m.exit});if(m.event==='init'&&!loaded){loaded=true;frame.contentWindow.postMessage(JSON.stringify({action:'load',xml:${JSON.stringify(xml)},autosave:0,title:'Artificial spike'}),${JSON.stringify(origins.editor)});}if(m.event==='save'&&typeof m.xml==='string'){window.spikeCandidates.push(m.xml);}});`;
const mime = path => path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : path.endsWith('.gif') ? 'image/gif' : path.endsWith('.ico') ? 'image/x-icon' : path.endsWith('.woff2') ? 'font/woff2' : 'text/plain';
const servers = [];
function server(port, handler) { const s=http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(error=>{report.errors.push(String(error));res.writeHead(500);res.end();});});return new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'127.0.0.1',()=>{servers.push(s);resolve(s);});}); }
let browser;
try {
await server(16632, async (req,res) => {
 const url = new URL(req.url, origins.editor);report.wire.push({origin:'editor',method:req.method,path:url.pathname,query:url.search});
 const path = url.pathname === '/' ? '/index.html' : url.pathname;
 const entry = files.get(path);
 if (req.method !== 'GET' || !entry) {report.missing.push(path);res.writeHead(403);res.end('Fixed manifest only');return;}
 const data = await fs.readFile(root + path);
 if (sha256(data) !== entry.sha256) throw new Error('Manifest mismatch ' + path);
 res.writeHead(200,{'Content-Type':mime(path),'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(data);
});
await server(16631, async (req,res) => {
 const path = new URL(req.url,origins.host).pathname;report.wire.push({origin:'host',method:req.method,path});
 if (req.method !== 'GET' || !['/','/host.js'].includes(path)) {res.writeHead(403);res.end();return;}
 res.writeHead(200,{'Content-Type':path==='/'?'text/html':'text/javascript','Content-Security-Policy':`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src ${origins.editor}; connect-src 'none'; base-uri 'none'; form-action 'none'`,'Cache-Control':'no-store'});
 res.end(path==='/'?`<!doctype html><title>Fixed vanilla draw.io spike</title><body style="margin:0"><iframe title="Vanilla draw.io" style="border:0;width:100vw;height:100vh" sandbox="allow-scripts allow-same-origin" src="${origins.editor}/?${query}"></iframe><script src="/host.js"></script>`:hostScript);
});
 browser=await chromium.launch();report.environment.chromium=browser.version();const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'allow'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(!Object.values(origins).includes(u.origin)){report.routeBlocked.push(route.request().url());return route.abort('blockedbyclient');}return route.continue();});
 await context.addInitScript(()=>{window.__spikeViolations=[];addEventListener('securitypolicyviolation',e=>window.__spikeViolations.push({directive:e.effectiveDirective,uri:e.blockedURI,line:e.lineNumber,source:e.sourceFile}));});
 const page=await context.newPage();page.on('console',m=>report.console.push({type:m.type(),text:m.text().slice(0,1000)}));page.on('pageerror',e=>report.errors.push(String(e)));
 page.on('request',r=>report.attempted.push({url:r.url(),type:r.resourceType()}));page.on('requestfailed',r=>report.failed.push({url:r.url(),error:r.failure()?.errorText}));
 await page.goto(origins.host,{waitUntil:'domcontentloaded'});
 try {await page.waitForFunction(()=>window.spikeEvents.some(x=>x.event==='load'),{},{timeout:20000});report.result='loaded';}catch{report.result='startup-timeout';}
 for(const frame of page.frames()) {try {report.violations.push(...await frame.evaluate(()=>window.__spikeViolations??[]));}catch{}}
 report.events=await page.evaluate(()=>window.spikeEvents);const child=page.frames().find(f=>f.url().startsWith(origins.editor));
 if(child){
 report.upstream=await child.evaluate(()=>({sync:window.urlParams?.sync,compressed:window.Editor?.defaultCompressed,nullImages:[...document.querySelectorAll('img')].filter(x=>x.getAttribute('src')==='null').map(x=>x.outerHTML.slice(0,500))}));
 if (!mode.startsWith('baseline') && report.result==='loaded') {
  try {
   const label=child.getByText('SPIKE BEFORE',{exact:true});await label.waitFor({state:'visible',timeout:5000});await label.dblclick();
   const edit=child.locator('.mxCellEditor');await edit.waitFor({state:'visible',timeout:3000});await edit.fill('SPIKE AFTER');
   await child.getByRole('button',{name:'Save',exact:true}).click();
   await page.waitForFunction(()=>window.spikeEvents.some(x=>x.event==='save'),{},{timeout:5000});
   report.saved=await page.evaluate(()=>window.spikeCandidates.map(xml=>({bytes:xml.length,uncompressed:xml.includes('<mxGraphModel'),before:xml.includes('SPIKE BEFORE'),after:xml.includes('SPIKE AFTER')})));
   await child.getByRole('button',{name:'Exit',exact:true}).click();
   await page.waitForFunction(()=>window.spikeEvents.some(x=>x.event==='exit'),{},{timeout:3000});
   report.result=report.saved.some(x=>x.after&&x.uncompressed)?'edited-saved-exited':'save-content-mismatch';
  } catch(e) {report.uiFailure=String(e);report.result='ui-step-failed';}
 }
 report.events=await page.evaluate(()=>window.spikeEvents);
 report.negativeResults=await child.evaluate(async () => {
  const sentinel='http://127.0.0.1:16633/__drawio_negative__';
  const outcomes={};
  try{await fetch(sentinel+'-fetch');outcomes.fetch='resolved';}catch(e){outcomes.fetch=e.name;}
  try{new WebSocket('ws://127.0.0.1:16633/__drawio_negative__-ws');outcomes.websocket='constructed';}catch(e){outcomes.websocket=e.name;}
  const image=new Image();image.src=sentinel+'-image';document.body.append(image);
  const css=document.createElement('div');css.style.backgroundImage='url('+sentinel+'-css)';document.body.append(css);
  try{const registration=await navigator.serviceWorker.register('/__drawio_negative__-sw.js');outcomes.serviceWorker={scope:registration?.scope??null};}catch(e){outcomes.serviceWorker=e.name;}
  try{new Worker('/__drawio_negative__-worker.js');outcomes.worker='constructed';}catch(e){outcomes.worker=e.name;}
  const script=document.createElement('script');script.textContent='window.__forbiddenInlineExecuted=true';document.head.append(script);outcomes.inlineExecuted=window.__forbiddenInlineExecuted===true;
  outcomes.registrations=(await navigator.serviceWorker.getRegistrations()).length;
  try{outcomes.positive=(await fetch('/resources/dia.txt?positive-control')).status;}catch(e){outcomes.positive=e.name;}
  try{outcomes.manifestDenied=(await fetch('/__outside_manifest__')).status;}catch(e){outcomes.manifestDenied=e.name;}
  return outcomes;
 });
 await page.waitForTimeout(100);
 report.violations=[];for(const f of page.frames()){try{report.violations.push(...await f.evaluate(()=>window.__spikeViolations??[]));}catch{}}
 report.ui=(await child.locator('body').innerText()).slice(0,6000);report.buttons=await child.locator('button').allTextContents();}
 await page.screenshot({path:path.join(outputDir, 'screenshot.png'),fullPage:true});
} catch(error){report.errors.push(String(error));report.result='harness-error';}
finally {
 await browser?.close().catch(error => report.errors.push(String(error)));
 await Promise.all(servers.map(s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); })));
 try {
  if (mode === 'baseline') { assert.equal(report.result, 'loaded'); assert.deepEqual(report.errors, []); }
  else if (mode === 'approved-xml-negative') verifyObservation(report);
  else { assert.equal(report.result, 'edited-saved-exited'); assert.deepEqual(report.errors, []); }
 } catch (error) { report.validationFailure=String(error); process.exitCode=1; }
 await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report,null,2), { flag: 'wx' });
 console.log(JSON.stringify({result:report.result,validationFailure:report.validationFailure,outputDir}));
}
