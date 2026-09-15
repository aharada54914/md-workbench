import { FILE_WATCH_POLL } from '../constants';

// One renderer-wide budget, including reads belonging to closed/rebound sessions.
// Invalidating a result never cancels the native work already dispatched.
const jobs = new Map<object, { due: number; run: () => Promise<void> }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let nextStart = 0;

function wake(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (running) return;
  if (!jobs.size) return;
  const earliest = Math.min(...Array.from(jobs.values(), job => job.due));
  timer = setTimeout(dispatch, Math.max(0, earliest - Date.now(), nextStart - Date.now()));
}

function dispatch(): void {
  timer = undefined;
  const now = Date.now();
  // Map insertion order gives a due job its turn even if another path keeps saving.
  const entry = [...jobs].find(([, job]) => job.due <= now);
  if (!entry || now < nextStart) { wake(); return; }
  const [key, job] = entry;
  jobs.delete(key);
  running = true;
  nextStart = now + FILE_WATCH_POLL.MIN_START_INTERVAL;
  void Promise.resolve().then(job.run).catch(error => {
    console.error('[FileWatcher] Unexpected scheduler failure:', error);
  }).finally(() => { running = false; wake(); });
}

export function scheduleWatchRead(key: object, due: number, run: () => Promise<void>): void {
  const previous = jobs.get(key);
  jobs.set(key, { due: Math.min(due, previous?.due ?? Infinity), run });
  wake();
}

export function cancelWatchRead(key: object): void {
  jobs.delete(key);
  wake();
}
