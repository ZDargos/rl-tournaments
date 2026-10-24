export function StandingsTable({ rows, myCompetitorIds = [] }: { rows: any[]; myCompetitorIds?: number[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th><th>Name</th><th className="num">Pts</th><th className="num">W</th><th className="num">L</th>
            <th className="num hide-sm">Games</th><th className="num hide-sm">GD</th><th className="num hide-sm">Buchholz</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entrantId} className={myCompetitorIds.includes(r.competitorId) ? 'highlight' : ''}>
              <td>{r.rank}</td>
              <td style={{ fontWeight: 650 }}>{r.name}{r.byes ? <span className="badge" style={{ marginLeft: 6 }}>bye×{r.byes}</span> : null}</td>
              <td className="num" style={{ fontWeight: 800 }}>{r.points}</td>
              <td className="num">{r.wins}</td>
              <td className="num">{r.losses}</td>
              <td className="num hide-sm">{r.gameWins}–{r.gameLosses}</td>
              <td className="num hide-sm">{r.goalDiff > 0 ? '+' : ''}{r.goalDiff}</td>
              <td className="num hide-sm">{r.buchholz}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SixmansStandings({ pool, me, showSkill }: { pool: any; me?: string | null; showSkill?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th><th>Player</th><th className="num">Pts</th><th className="num">W–L</th><th className="num">GD</th><th className="num">GF</th><th className="num">GP</th>
            {showSkill && <th className="num">Skill</th>}
          </tr>
        </thead>
        <tbody>
          {pool.standings.map((r: any) => (
            <tr key={r.playerId} className={`${r.qualified ? 'qualified' : ''} ${r.playerId === me ? 'highlight' : ''}`}>
              <td>{r.rank}</td>
              <td style={{ fontWeight: 650 }}>
                {r.name} {r.qualified && <span className="badge green" style={{ marginLeft: 4 }}>Q</span>}
              </td>
              <td className="num" style={{ fontWeight: 800 }}>{r.points}</td>
              <td className="num">{r.wins}–{r.losses}</td>
              <td className="num">{r.goalDiff > 0 ? '+' : ''}{r.goalDiff}</td>
              <td className="num">{r.goalsFor}</td>
              <td className="num">{r.played}/{r.scheduled}</td>
              {showSkill && <td className="num">{r.skill?.toFixed?.(1) ?? r.skill}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
