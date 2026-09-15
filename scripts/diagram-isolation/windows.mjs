// Packaged WebView2 observer. CDP is injected only into this owned CI process.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { commands, observeNativeDenials } from './native-receipts.mjs';
const [binaryArg, outArg, mode] = process.argv.slice(2);
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw Error('Requires hosted Windows CI');
const binary=resolve(binaryArg), out=resolve(outArg);
await mkdir(out,{recursive:false});
const report={version:1,status:'failed',platform:process.platform,osRelease:process.env.ImageOS,commit:process.env.GITHUB_SHA,checks:{},missing:['macOS WKWebView runtime','Linux WebKitGTK runtime','real draw.io runtime'],errors:[]};
let child, browser, stdout='', stderr='';
let requiredFailure=false, requiredUnsupported=false;
async function requiredObservation(name, observe) {
 try { await observe(); }
 catch(error) { requiredFailure=true;report.errors.push(`${name}: ${String(error?.message??error)}`); }
}
const bounded=(current, chunk)=>(current+chunk.toString()).slice(-262144);
async function until(fn, ms=15000) { const deadline=Date.now()+ms; do { const value=await fn(); if(value)return value; await delay(100); }while(Date.now()<deadline); throw Error('Observation timeout'); }
try {
 report.fixtureHashes={};
 for(const name of ['host.html','child.html','host.mjs','child.mjs','protocol.mjs'])report.fixtureHashes[name]=createHash('sha256').update(await readFile(new URL(`../../src-tauri/src/diagram_spike/${name}`,import.meta.url))).digest('hex');
 report.binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
 child=spawn(binary,['--diagram-isolation-spike'],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',c=>{stdout=bounded(stdout,c)});child.stderr.on('data',c=>{stderr=bounded(stderr,c)});
 child.on('error',error=>report.errors.push(error.message));
 browser=await until(async()=>{try{return await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:1000})}catch{return null}});
 report.engine=browser.version();
 const pages=()=>browser.contexts().flatMap(c=>c.pages());
 if(mode==='--expect-disabled'){
  await until(async()=>{for(const p of pages())if(await p.evaluate(()=>!!window.__TAURI_INTERNALS__).catch(()=>false))return true;return false});
  await delay(1000);assert.equal(pages().some(p=>p.url().includes('mdwdiagram')),false);
  report.checks.defaultFeatureIgnoresLaunchFlag=true;report.status='passed_default_disabled';
 } else {
 const fixture=await until(()=>pages().find(p=>p.url().startsWith('http://mdwdiagramhost.localhost/')));
 const main=await until(async()=>{for(const p of pages())if(p!==fixture && await p.evaluate(()=>!!window.__TAURI_INTERNALS__).catch(()=>false))return p;return null});
 report.roundtrip=await until(async()=>{const r=await fixture.evaluate(()=>window.__diagramReport);return r && r.status!=='starting'?r:null});
 const frame=fixture.frames().find(f=>f.url().startsWith('http://mdwdiagramfixture.localhost/'));
 if(frame)report.child=await frame.evaluate(()=>window.__diagramChildReport);
 if(report.roundtrip.status==='unsupported_origin' || report.child?.status==='unsupported_origin')report.status='unsupported';
 assert.equal(report.roundtrip.status,'passed_roundtrip','Opaque/equal origins or failed exact targetOrigin are unsupported');
 assert.equal(report.roundtrip.childOrigin,'http://mdwdiagramfixture.localhost');
 assert.ok(frame,'Actual child frame required');
 assert.equal(report.child.observedHost,'http://mdwdiagramhost.localhost');assert.equal(report.child.parentAccessible,false);
 report.checks.exactOriginRoundtrip=true;
 // Positive control captures the genuine key in memory only. Never serialize it.
 const key=await main.evaluate(async()=>{
  const ti=window.__TAURI_INTERNALS__, saved=window.fetch; let key;
  window.fetch=function(input,init){const headers=new Headers(init?.headers);key=headers.get('Tauri-Invoke-Key')??key;return Reflect.apply(saved,this,[input,init])};
  let timer;try{const label=await Promise.race([ti.invoke('get_current_window_label'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Control receipt timeout')),2000)})]);if(label!=='main')throw Error('Wrong main')}finally{clearTimeout(timer);window.fetch=saved}return key;
 });assert.ok(key,'Genuine positive native control required');
 report.checks.genuineNativeControl=true;
 report.nativeCustom=await observeNativeDenials({
  contexts:[['wrapper',fixture],['child',frame]].map(([name,target])=>({name,send:()=>target.evaluate(({key,commands})=>{
   const bridge=window.chrome?.webview;if(!bridge)return 'unavailable';
   for(const cmd of commands)bridge.postMessage(JSON.stringify({cmd,payload:{path:'fixture-unselected',windowLabel:'main'},callback:1,error:2,options:{customProtocolIpcBlocked:true},__TAURI_INVOKE_KEY__:key}));return 'sent';
  },{key,commands})})),readLog:()=>stderr,waitFor:until,
 });
 for(const [context,observation] of Object.entries(report.nativeCustom)){
  report.checks[`${context}Bridge`]=observation.bridge;
  if(observation.status==='passed')continue;
  if(observation.status==='unsupported')requiredUnsupported=true;else requiredFailure=true;
  report.missing.push(`${context} native custom IPC rejection receipt: ${observation.reason}`);
 }
 // Plugins use Tauri's own promise callbacks: require an ACL denial receipt,
 // rather than treating CSP or malformed-argument failures as ACL proof.
 await requiredObservation('plugin ACL',async()=>{
 report.pluginReceipts=await fixture.evaluate(async()=>{
  const ti=window.__TAURI_INTERNALS__;if(!ti)return {unsupported:'missing internals'};
  const commands=['plugin:fs|read_file','plugin:fs|write_file','plugin:shell|open','plugin:dialog|open','plugin:event|emit','plugin:webview|create_webview_window'];
  return Object.fromEntries(await Promise.all(commands.map(async command=>{
   let timer;try{await Promise.race([ti.invoke(command,{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('receipt timeout')),2000)})]);return [command,'UNEXPECTED_SUCCESS']}
   catch(error){return [command,typeof error==='string'?error:JSON.stringify(error)]}finally{clearTimeout(timer)}
  })));
 });
 for(const [command,receipt] of Object.entries(report.pluginReceipts))assert.match(receipt,/not allowed|denied|forbidden|not permitted|capabilit/i,`${command}: native ACL receipt required`);
 });
 // Real DOM resource actions remain subject to CSP despite CDP's own ability
 // to evaluate JavaScript. No arbitrary remote host or user path is requested.
 await requiredObservation('CSP',async()=>{
 report.csp=await fixture.evaluate(async()=>{
  const before=window.__diagramReport.violations.length;
  await fetch('https://example.invalid/diagram-spike',{signal:AbortSignal.timeout(2000)}).catch(()=>{});
  const script=document.createElement('script');script.textContent='window.__diagramInlineExecuted=true';document.body.append(script);
  await new Promise(r=>setTimeout(r,100));script.remove();
  return {violations:window.__diagramReport.violations.slice(before),inlineExecuted:window.__diagramInlineExecuted===true};
 });assert.equal(report.csp.inlineExecuted,false);assert.ok(report.csp.violations.some(v=>v.directive==='connect-src'));assert.ok(report.csp.violations.some(v=>v.directive==='script-src-elem'));
 report.checks.cspIsSeparateFromNativeReceipt=true;
 });
 // Trusted main has no permission to retrieve fixture assets. Main's CSP may
 // block this fetch first; report that distinction and do not invent a receipt.
 report.mainRoute=await main.evaluate(async()=>{try{const r=await fetch('http://mdwdiagramhost.localhost/host.mjs',{signal:AbortSignal.timeout(2000)});return {status:r.status}}catch(error){return {unavailableReceipt:true,error:String(error?.name??'Error')}}});
 if(report.mainRoute.status!==403)report.missing.push('main foreign protocol caller runtime receipt (CSP/CORS may hide receipt; native unit covers route owner)');
 await requiredObservation('popup',async()=>{
 const before=pages().length;await fixture.evaluate(()=>window.open('https://example.invalid/diagram-spike','_blank'));await delay(200);assert.equal(pages().length,before);report.checks.popupDenied=true;
 });
 // A reload must never start another exchange with the old nonce.
 await requiredObservation('reload',async()=>{
 await fixture.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
 assert.equal(await fixture.evaluate(()=>window.__diagramReport?.status).catch(()=>undefined),undefined);
 report.checks.reloadRetired=true;
 });
 report.missing.push('download native callback runtime receipt','all network vectors/socket capture','destroy/recreate runtime observer');
 // This is a bounded first observer, not complete T04/T16 or platform acceptance.
 report.status=requiredFailure?'failed':requiredUnsupported?'unsupported':'passed_measured_subset';
 if(requiredFailure||requiredUnsupported)process.exitCode=1;
 }
} catch(error) { if(report.status!=='unsupported')report.status='failed';report.errors.push(String(error?.stack??error));process.exitCode=1; }
finally {
 if(browser)await Promise.race([browser.close().catch(()=>{}),delay(5000)]);
 if(child?.pid){
  if(child.exitCode===null && child.signalCode===null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000})}catch{/* Check actual process exit below. */}}
  const deadline=Date.now()+3000;while(child.exitCode===null && child.signalCode===null && Date.now()<deadline)await delay(50);
  report.cleanup={ownedProcessExited:child.exitCode!==null || child.signalCode!==null};
  if(!report.cleanup.ownedProcessExited){report.status='failed';report.errors.push('Owned process exit unconfirmed');process.exitCode=1}
 }
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 // Logs omit captured invoke key and nonce. Native receipt logs contain only
 // constant command names; do not emit CDP contents, requests, or fixture HTML.
 await writeFile(join(out,'native-receipts.log'),stderr.split('\n').filter(l=>l.startsWith('MDW_DIAGRAM_IPC_DENIED ')).join('\n'));
}
