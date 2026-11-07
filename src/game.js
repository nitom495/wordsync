const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeWord(value) {
  return String(value ?? '').trim();
}

export function wordError(value) {
  const word = normalizeWord(value);
  if (!word) return '请输入一个词语';
  if (Array.from(word).length > 20) return '词语最多 20 个字';
  return '';
}

export function consensus(words) {
  const counts = new Map();
  let leader = '';
  let count = 0;
  for (const raw of words) {
    const word = normalizeWord(raw);
    const next = (counts.get(word) ?? 0) + 1;
    counts.set(word, next);
    if (next > count) {
      leader = word;
      count = next;
    }
  }
  const total = words.length;
  return { leader, count, total, percent: total ? Math.round(count / total * 100) : 0, matched: total >= 2 && count === total };
}

export function createRoomCode(bytes = crypto.getRandomValues(new Uint8Array(6))) {
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function remainingSeconds(revealedAtMs, durationSeconds, nowMs = Date.now()) {
  return Math.max(0, Math.ceil((revealedAtMs + durationSeconds * 1000 - nowMs) / 1000));
}
