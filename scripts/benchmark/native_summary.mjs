export function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function summarizeNative(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = JSON.stringify([trial.mode, trial.fixture]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return [...groups.values()].map(rows => {
    const successful = rows.filter(row => row.status === 'success' && Number.isFinite(row.observed_ms) && row.observed_ms >= 0);
    const values = successful.map(row => row.observed_ms);
    const metrics = ['working_set_bytes', 'private_bytes'];
    const memory = Object.fromEntries(metrics.map(metric => {
      const samples = successful.filter(row => row.memory?.status === 'success').map(row => row.memory.peak[metric]).filter(Number.isFinite);
      return [metric, { n: samples.length, p50: percentile(samples, .5), p95: percentile(samples, .95) }];
    }));
    return {
      mode: rows[0].mode, fixture_sha256: rows[0].fixture,
      successful: successful.length, failed: rows.length - successful.length,
      observed_ms: { p50: percentile(values, .5), p95: percentile(values, .95) }, memory,
      required_samples: rows[0].mode === 'warm' ? 50 : 30,
      production_benchmark_eligible: false,
      reason: 'Diagnostic CDP observer; fixture groups and failures are not pooled or hidden.',
    };
  });
}
