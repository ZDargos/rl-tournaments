/** Convert a wall-clock time ("2026-11-02 19:00") in an IANA timezone to a UTC ISO string. */
export function zonedToUtc(local: string, timeZone: string): string {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) {
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) throw new Error('Use a time like 2026-11-02 19:00.');
    return d.toISOString();
  }
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - t;
  };
  // Two passes handle DST boundaries.
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return new Date(utc).toISOString();
}
