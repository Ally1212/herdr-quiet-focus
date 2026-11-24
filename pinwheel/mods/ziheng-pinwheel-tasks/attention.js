// Presentation evidence only: never change OSC/core status or send terminal input.
export function questionInScreen(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  // Only the current queue immediately above the composer. Old transcript is excluded.
  let composer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*›(?:\s|$)/u.test(lines[i])) { composer = i; break; }
  }
  if (composer < 0) return null;
  const tail = lines.slice(Math.max(0, composer - 24), composer);
  let queue = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (/^\s*[•◦]\s+Queued follow-up inputs\s*$/u.test(tail[i])) { queue = i; break; }
  }
  if (queue < 0) return null;
  const rows = tail.slice(queue + 1).filter(l => l.trim());
  // Anchor the entire live widget: a later response invalidates an old queue.
  if (rows.length !== 2) return null;
  const count = rows[0].match(/^\s*\?\s+([1-9][0-9]*)\s+questions?(?:\s*·\s*[^\n]+)?\s*$/u);
  if (!count || !/^\s*\S+(?:\s+\S+)*\s+to answer\s*$/u.test(rows[1])) return null;
  const n = Number(count[1]);
  return Number.isSafeInteger(n) ? { kind: "question", count: n } : null;
}

export function observed(previous, evidence, now) {
  if (!evidence) return null;
  return { ...evidence, since: previous?.kind === evidence.kind ? previous.since : now, checked: now, stale: false };
}

export function unavailable(previous, now) {
  // Do not silently turn an unresolved question into running when a read fails.
  return previous ? { ...previous, stale: true, failed: now } : null;
}

export function freshEvidence(entries, now) {
  // Shared data is persisted by Herdr. Ignore a previous process's old evidence.
  return Object.fromEntries(Object.entries(entries ?? {}).filter(([, e]) =>
    e && Number.isFinite(e.checked) && now >= e.checked && now - e.checked < 15000));
}
