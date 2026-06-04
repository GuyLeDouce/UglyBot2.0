export function parseDurationToMs(input) {
  if (!input || typeof input !== 'string') return null;

  const re = /(\d+)\s*(d|h|m|s)/gi;
  let match;
  let totalMs = 0;
  let found = false;

  while ((match = re.exec(input)) !== null) {
    found = true;
    const n = Number(match[1]);
    const unit = String(match[2]).toLowerCase();
    if (!Number.isFinite(n)) return null;

    if (unit === 'd') totalMs += n * 24 * 60 * 60 * 1000;
    else if (unit === 'h') totalMs += n * 60 * 60 * 1000;
    else if (unit === 'm') totalMs += n * 60 * 1000;
    else if (unit === 's') totalMs += n * 1000;
  }

  if (!found || totalMs <= 0) return null;
  return totalMs;
}

export function formatDiscordTs(date) {
  const seconds = Math.floor(new Date(date).getTime() / 1000);
  return '<t:' + seconds + ':f> (<t:' + seconds + ':R>)';
}
