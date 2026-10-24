import { Link } from 'react-router-dom';
import { MatchBadge } from './ui';

export type MatchDto = any;

function sideClass(m: MatchDto, s: 'a' | 'b') {
  if (m.status !== 'completed' || !m.winner) return '';
  return m.winner === s ? 'win' : 'lose';
}

export function MatchCard({ m, mine, showLabel }: { m: MatchDto; mine?: boolean; showLabel?: boolean }) {
  const score = (s: 'a' | 'b') => {
    if (m.status === 'completed') return m.walkover ? '' : m.forfeit ? (m.winner === s ? 'W' : 'FF') : s === 'a' ? m.winsA : m.winsB;
    if (m.status === 'ready' && m.liveGames?.length) {
      const w = m.liveGames.filter((g: any) => (s === 'a' ? g.a > g.b : g.b > g.a)).length;
      return <span className="muted">{w}</span>;
    }
    return '';
  };
  const name = (s: 'a' | 'b') => {
    const side = m[s];
    if (side) return side.name;
    const src = s === 'a' ? m.sourceA : m.sourceB;
    if (src?.type === 'bye' || (m.walkover && !side)) return <span className="tbd">bye</span>;
    return <span className="tbd">TBD</span>;
  };
  return (
    <Link to={`/m/${m.id}`} className={`mcard ${mine ? 'mine' : ''}`} aria-label={`Match ${m.id}`}>
      {showLabel && <div className="foot" style={{ background: 'transparent' }}><span>{m.label}</span></div>}
      <div className={`side ${sideClass(m, 'a')}`}><span>{name('a')}</span><span className="score">{score('a')}</span></div>
      <div className={`side ${sideClass(m, 'b')}`}><span>{name('b')}</span><span className="score">{score('b')}</span></div>
      <div className="foot">
        <span>#{m.id} · Bo{m.bestOf}</span>
        {m.walkover ? <span>bye</span> : m.status === 'completed' ? <span>final</span> : <span>{m.status === 'ready' ? (m.liveGames?.length ? 'live (unofficial)' : 'ready') : m.status.replace(/_/g, ' ')}</span>}
      </div>
    </Link>
  );
}

const BRACKET_TITLES: Record<string, string> = { winners: 'Winners bracket', losers: 'Losers bracket', grand_final: 'Grand final', grand_final_reset: 'Grand final reset', third_place: 'Third place', finals: 'Finals' };

function roundName(bracket: string, round: number, total: number) {
  if (bracket === 'winners' || bracket === 'finals') {
    const left = total - round;
    if (left === 0) return bracket === 'finals' ? 'Final' : total === 1 ? 'Final' : 'Final';
    if (left === 1) return 'Semifinals';
    if (left === 2) return 'Quarterfinals';
    return `Round ${round}`;
  }
  return `Round ${round}`;
}

/** Elimination bracket: one column per round, per bracket section. */
export function BracketView({ matches, myIds = [], finalLabel }: { matches: MatchDto[]; myIds?: number[]; finalLabel?: string }) {
  const sections = ['winners', 'finals', 'losers', 'grand_final', 'grand_final_reset', 'third_place'];
  const present = sections.filter((b) => matches.some((m) => m.bracket === b));
  const de = present.includes('losers');
  return (
    <div className="stack">
      {present.map((b) => {
        const ms = matches.filter((m) => m.bracket === b && !(m.status === 'void' && b === 'grand_final_reset'));
        if (!ms.length) return null;
        const rounds = [...new Set(ms.map((m) => m.round))].sort((x, y) => x - y);
        const total = Math.max(...rounds);
        return (
          <section key={b}>
            {(de || present.length > 1) && <h3>{b === 'winners' && !de ? finalLabel ?? 'Bracket' : BRACKET_TITLES[b] ?? b}</h3>}
            <div className="bracket-scroll">
              <div className="bracket">
                {rounds.map((r) => (
                  <div className="bracket-col" key={r}>
                    {!['grand_final', 'grand_final_reset', 'third_place'].includes(b) && <h4>{roundName(b, r, total)}</h4>}
                    {ms.filter((m) => m.round === r).sort((x, y) => x.position - y.position).map((m) => (
                      <MatchCard key={m.id} m={m} mine={myIds.includes(m.id)} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Round-by-round list (Swiss, round robin, 6mans group). */
export function RoundsView({ matches, myIds = [], groupBy = 'round' }: { matches: MatchDto[]; myIds?: number[]; groupBy?: 'round' }) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  void groupBy;
  return (
    <div className="stack">
      {rounds.map((r) => (
        <div key={r}>
          <h3>Round {r}</h3>
          <div className="grid auto">
            {matches.filter((m) => m.round === r).map((m) => <MatchCard key={m.id} m={m} mine={myIds.includes(m.id)} showLabel />)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MatchList({ matches, myIds = [] }: { matches: MatchDto[]; myIds?: number[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>#</th><th>Match</th><th>Blue (A)</th><th className="num">Score</th><th>Orange (B)</th><th>Status</th></tr>
        </thead>
        <tbody>
          {matches.map((m) => (
            <tr key={m.id} className={myIds.includes(m.id) ? 'highlight' : ''}>
              <td className="mono">{m.id}</td>
              <td><Link to={`/m/${m.id}`}>{m.label}</Link></td>
              <td className={m.winner === 'a' ? 'team-a' : ''} style={{ fontWeight: m.winner === 'a' ? 750 : 400 }}>{m.a?.name ?? <span className="tbd">TBD</span>}</td>
              <td className="num">{m.status === 'completed' ? (m.walkover ? 'bye' : m.forfeit ? 'FF' : `${m.winsA}–${m.winsB}`) : '—'}</td>
              <td className={m.winner === 'b' ? 'team-b' : ''} style={{ fontWeight: m.winner === 'b' ? 750 : 400 }}>{m.b?.name ?? <span className="tbd">{m.walkover ? 'bye' : 'TBD'}</span>}</td>
              <td><MatchBadge status={m.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
