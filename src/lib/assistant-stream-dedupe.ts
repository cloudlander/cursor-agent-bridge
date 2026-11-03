import { collapseExactBackToBackDuplicate } from "./assistant-text-dedupe.js";

/** Minimum length before treating a chunk as a repeated cumulative snapshot (not a token delta). */
const MIN_RESTART_SNAPSHOT_CHARS = 32;

/**
 * Cursor CLI sometimes re-emits a large cumulative body that already appears inside
 * the current snapshot (e.g. intro paragraph + full answer, then answer-only snapshot).
 */
function isEmbeddedSnapshotRepeat(snapshot: string, text: string): boolean {
  if (text.length < MIN_RESTART_SNAPSHOT_CHARS || snapshot.length === 0) {
    return false;
  }
  if (snapshot.includes(text)) return true;
  const first = text[0];
  for (let i = 1; i < snapshot.length; i++) {
    if (snapshot[i] !== first) continue;
    if (snapshot.slice(i, i + text.length) === text) return true;
  }
  return false;
}

/** Merge when the CLI restarts mid-body but shares a suffix/prefix overlap with snapshot. */
function mergeWithSuffixPrefixOverlap(snapshot: string, text: string): string | null {
  if (text.length < MIN_RESTART_SNAPSHOT_CHARS) return null;
  const maxOverlap = Math.min(snapshot.length, text.length);
  for (let k = maxOverlap; k >= 8; k--) {
    if (snapshot.slice(-k) === text.slice(0, k)) {
      return text.slice(k);
    }
  }
  return null;
}

/**
 * Deduplicate Cursor assistant text whether the source sends incremental deltas,
 * growing cumulative snapshots, or a final full message repeat (stream-json / ACP).
 */
export function createAssistantTextDeduper(
  onText: (delta: string) => void,
): (text: string) => void {
  let snapshot = "";
  return (text: string) => {
    if (!text) return;
    if (text === snapshot) return;

    if (text.startsWith(snapshot)) {
      const delta = text.slice(snapshot.length);
      if (delta) onText(delta);
      snapshot = text;
      return;
    }

    if (snapshot.startsWith(text)) return;

    if (isEmbeddedSnapshotRepeat(snapshot, text)) return;

    const overlapDelta = mergeWithSuffixPrefixOverlap(snapshot, text);
    if (overlapDelta !== null) {
      if (overlapDelta) onText(overlapDelta);
      snapshot += overlapDelta;
      return;
    }

    onText(text);
    snapshot += text;
  };
}

/**
 * Like {@link createAssistantTextDeduper}, but also collapses an exact doubled body
 * (X + X) before forwarding to SSE clients.
 */
export function createGuardedAssistantTextEmitter(
  onDelta: (delta: string) => void,
): (chunk: string) => void {
  let emitted = "";
  return createAssistantTextDeduper((delta) => {
    const combined = emitted + delta;
    const normalized = collapseExactBackToBackDuplicate(combined);
    const wireDelta = normalized.slice(emitted.length);
    if (!wireDelta) return;
    emitted = normalized;
    onDelta(wireDelta);
  });
}
