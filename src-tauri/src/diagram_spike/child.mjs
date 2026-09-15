import { receiver, envelope, LIMITS } from './protocol.mjs';
const meta = name => document.querySelector(`meta[name="${name}"]`).content;
const session = meta('session'), hostOrigin = meta('host-origin'), expectedChild = meta('child-origin');
const report = globalThis.__diagramChildReport = {status:'starting',origin:location.origin,observedHost:null,parentAccessible:false};
try { report.parentAccessible = !!parent.document; } catch { /* Expected cross-origin denial. */ }
if (location.origin === 'null' || location.origin !== expectedChild || location.origin === hostOrigin || parent === window) {
  report.status = 'unsupported_origin';
} else {
  const gate = receiver({source:parent,origin:hostOrigin,session,steps:[{seq:1,kinds:['load','cancel']}]});
  const stop = () => { gate.retire(); clearTimeout(timer); removeEventListener('message', onMessage); };
  const timer = setTimeout(() => { report.status='timeout'; stop(); }, LIMITS.timeout);
  function onMessage(event) {
    if (event.source === parent) report.observedHost = event.origin;
    const result = gate.receive(event);
    if (result.status === 'ignored') return;
    if (result.status !== 'accepted') { report.status=result.reason ?? result.status; stop(); return; }
    if (result.value.kind === 'load') {
      // No HTML/XML/image parsing and no original document or persistence.
      parent.postMessage(envelope(session,2,'candidate',result.value.text),hostOrigin);
      report.status='candidate_sent';
    } else { report.status='cancelled'; }
    stop();
  }
  addEventListener('message',onMessage);
  addEventListener('pagehide',stop,{once:true});
  parent.postMessage(envelope(session,0,'ready'),hostOrigin);
}
