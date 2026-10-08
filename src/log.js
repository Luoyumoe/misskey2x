/**
 * Write one structured JSON event. JSON lines work well with Docker logs and
 * keep note text searchable without producing multi-line log entries.
 */
export function logEvent(logger, event, fields = {}, level = 'info') {
  const target = logger?.[level] || logger?.info || logger?.log;
  if (typeof target !== 'function') return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    scope: 'misskey-to-x',
    event,
    ...fields,
  });
  try {
    target.call(logger, line);
  } catch {
    // Logging must never prevent webhook acknowledgement or queue progress.
  }
}
