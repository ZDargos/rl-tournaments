import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Search members of a Discord server (people who used the site/bot, plus a live bot search). */
export function MemberPicker({ guildId, onPick, placeholder = 'Search server members…', exclude = [] }: { guildId: string; onPick: (u: { id: string; username: string; displayName: string }) => void; placeholder?: string; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api<any[]>(`/api/guilds/${guildId}/members?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, guildId]);
  const shown = results.filter((r) => !exclude.includes(r.id));
  return (
    <div style={{ position: 'relative' }}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={manual ? 'Discord user id (18–19 digits)' : placeholder} aria-label="Member search" />
        {manual && /^\d{15,25}$/.test(q.trim()) && <button className="btn small" onClick={() => { onPick({ id: q.trim(), username: q.trim(), displayName: q.trim() }); setQ(''); }}>Add</button>}
        <button className="btn ghost small" type="button" onClick={() => setManual((m) => !m)} title="Enter a Discord user id instead">{manual ? 'Search' : 'By id'}</button>
      </div>
      {!manual && shown.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, marginTop: 4, padding: 6 }}>
          {shown.map((r) => (
            <button key={r.id} className="btn ghost small" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => { onPick(r); setQ(''); setResults([]); }}>
              {r.displayName} <span className="muted">@{r.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
