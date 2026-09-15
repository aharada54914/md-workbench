import { receiver, envelope, LIMITS } from './protocol.mjs';
const meta = name => document.querySelector(`meta[name="${name}"]`).content;
const session = meta('session'), expectedHost = meta('host-origin'), childOrigin = meta('child-origin');
// Only nonsecret observations are exposed to the packaged observer.
const report = globalThis.__diagramReport = { version:1, status:'starting', hostOrigin:location.origin, expectedHost, expectedChild:childOrigin, childOrigin:null, candidate:false, violations:[] };
document.addEventListener('securitypolicyviolation', event => {
  if (report.violations.length < 32) report.violations.push({directive:event.effectiveDirective,blocked:event.blockedURI});
});
if (location.origin === 'null' || location.origin !== expectedHost || location.origin === childOrigin) {
  report.status = 'unsupported_origin';
} else {
  const iframe = document.createElement('iframe');
  iframe.title = 'Synthetic diagram child';
  iframe.sandbox = 'allow-scripts allow-same-origin';
  // Attach the empty browsing context first; register the listener before navigation.
  document.body.append(iframe);
  const peer = iframe.contentWindow;
  const gate = receiver({source:peer,origin:childOrigin,session,steps:[{seq:0,kinds:['ready']},{seq:2,kinds:['candidate','cancel']}]});
  let retired = false;
  const stop = () => { retired = true; gate.retire(); clearTimeout(timer); removeEventListener('message', onMessage); };
  const timer = setTimeout(() => { report.status = 'timeout'; stop(); }, LIMITS.timeout);
  function onMessage(event) {
    if (retired) return;
    if (event.source === peer) report.childOrigin = event.origin;
    if (event.source === peer && (event.origin === 'null' || event.origin === location.origin)) { report.status='unsupported_origin'; stop(); return; }
    const result = gate.receive(event);
    if (result.status === 'ignored') return;
    if (result.status !== 'accepted') { report.status = result.reason ?? result.status; stop(); return; }
    if (result.value.kind === 'ready') {
      peer.postMessage(envelope(session,1,'load','fixed synthetic text'),childOrigin);
    } else {
      report.candidate = result.value.kind === 'candidate' && result.value.text === 'fixed synthetic text';
      report.status = report.candidate ? 'passed_roundtrip' : 'cancelled'; stop();
    }
  }
  addEventListener('message', onMessage);
  addEventListener('pagehide', stop, {once:true});
  iframe.src = `${childOrigin}/`;
}
