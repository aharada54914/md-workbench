// Shared by the fixed browser fixtures and Node tests; no DOM, I/O or decoding.
export const LIMITS = Object.freeze({ envelope: 65536, text: 32768, messages: 32, cumulative: 262144, timeout: 10000 });
const bytes = value => new TextEncoder().encode(value).byteLength;
export function receiver({ source, origin, session, steps, now = () => performance.now(), limits = LIMITS }) {
  let index = 0, count = 0, total = 0, dead = false;
  const started = now();
  if (!source || !origin || origin === 'null' || !/^[a-f0-9]{32}$/.test(session)) throw new Error('unsupported_session');
  function retire() { dead = true; }
  function reject(reason) { retire(); return { status: 'rejected', reason }; }
  return { retire, receive(event) {
    if (dead) return { status: 'retired' };
    if (now() - started >= limits.timeout) return reject('timeout');
    // A foreign peer must not make this receiver parse, allocate or retire.
    if (event.source !== source || event.origin !== origin) return { status: 'ignored' };
    if (typeof event.data !== 'string' || event.data.length > limits.envelope) return reject('envelope');
    const size = bytes(event.data);
    if (size > limits.envelope || count >= limits.messages || total + size > limits.cumulative) return reject('budget');
    let value; try { value = JSON.parse(event.data); } catch { return reject('json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('schema');
    const withText = value.kind === 'load' || value.kind === 'candidate';
    const keys = withText ? ['kind','seq','session','text','v'] : ['kind','seq','session','v'];
    if (Object.keys(value).sort().join(',') !== keys.join(',') || value.v !== 1 || value.session !== session ||
        !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 31 ||
        !['ready','load','candidate','cancel'].includes(value.kind) ||
        (withText && (typeof value.text !== 'string' || bytes(value.text) > limits.text))) return reject('schema');
    const step = steps[index];
    if (!step || value.seq !== step.seq || !step.kinds.includes(value.kind)) return reject('sequence');
    index++; count++; total += size;
    return { status: 'accepted', value };
  } };
}
export const envelope = (session, seq, kind, text) => JSON.stringify({v:1,session,seq,kind,...(text === undefined ? {} : {text})});
