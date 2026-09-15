export const commands = Object.freeze(['native_read_path', 'native_get_grant', 'create_new_window', 'ai_send']);
const prefix = 'MDW_DIAGRAM_IPC_DENIED ';

export function nativeDenialCounts(log) {
  const counts = Object.fromEntries(commands.map(command => [command, 0]));
  // A stream chunk can end inside a JSON line, including immediately after '}'.
  for (const line of log.split('\n').slice(0, -1)) {
    if (!line.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(line.slice(prefix.length));
      if (value && Object.keys(value).length === 1 && commands.includes(value.command)) counts[value.command]++;
    } catch { /* Incomplete or unrelated output is not a receipt. */ }
  }
  return counts;
}

// WebView2 does not route iframe WebMessageReceived through Wry's top-level handler.
// JS bridge presence is only a dispatch observation, never a native denial receipt.
export async function observeNativeDenials({ contexts, readLog, waitFor }) {
  const observations = {};
  let priorConfirmed = true;
  for (const { name, send } of contexts) {
    const before = nativeDenialCounts(readLog());
    const difference = () => {
      const after = nativeDenialCounts(readLog());
      return Object.fromEntries(commands.map(command => [command, after[command] - before[command]]));
    };
    let bridge = 'unavailable', dispatchFailed = false;
    try { bridge = await send(); } catch { dispatchFailed = true; }
    if (!dispatchFailed && bridge === 'sent') {
      try { await waitFor(() => commands.every(command => difference()[command] >= 1), 5000); }
      catch { /* Retain the observed counts and continue other independent checks. */ }
    }
    const receipts = difference();
    let status, reason;
    if (dispatchFailed) { status = 'failed'; reason = 'dispatch_failed'; }
    else if (bridge !== 'sent') { status = 'unsupported'; reason = 'transport_unavailable'; }
    else if (commands.every(command => receipts[command] === 0)) { status = 'unsupported'; reason = 'no_native_receipt'; }
    else if (!priorConfirmed) { status = 'failed'; reason = 'prior_context_unconfirmed'; }
    else if (commands.every(command => receipts[command] === 1)) { status = 'passed'; }
    else { status = 'failed'; reason = 'unexpected_native_receipt_counts'; }
    observations[name] = { bridge, status, receipts, ...(reason ? { reason } : {}) };
    // A late receipt from a timed-out context must not establish a later pass.
    priorConfirmed &&= status === 'passed';
  }
  return observations;
}
