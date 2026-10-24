import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RANKS, STATE_LABELS, type TransitionAction } from '@rl/core';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useTournament } from './Tournament';
import { AVAILABILITY_ORDER, AvailabilityBadge, ConfirmButton, Empty, ErrorBox, Field, Help, MatchBadge, Modal, Spinner, StateBadge, Tabs, useToast } from '../components/ui';
import { HELP } from '../components/settingHelp';
import { ConfigForm } from '../components/ConfigForm';
import { MemberPicker } from '../components/MemberPicker';
import { SixmansAdmin } from './SixmansAdmin';
import { fmtDate } from '../lib/format';

type Tab = 'control' | 'settings' | 'entries' | 'sixmans' | 'matches' | 'people' | 'log';

const ACTION_LABEL: Record<string, string> = {
  publish: 'Publish', unpublish: 'Back to draft', open_registration: 'Open registration', close_registration: 'Close registration', mark_ready: 'Mark ready',
  start: 'Start tournament', pause: 'Pause', resume: 'Resume', cancel: 'Cancel tournament',
};

export function ManagePage() {
  const { id } = useParams();
  const { data: d, error, loading, reload } = useTournament(id);
  const [tab, setTab] = useState<Tab>('control');
  if (loading && !d) return <Spinner />;
  if (error && !d) return <ErrorBox error={error} />;
  if (!d) return null;
  if (!d.viewer.canManage) return <Empty icon="⛔" title="Only organizers can manage this tournament">Ask the tournament creator to add you as an admin.</Empty>;
  const t = d.tournament;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'control', label: 'Control' }, { id: 'settings', label: 'Settings' }, { id: 'entries', label: `Registrations (${d.entries.length})` },
    ...(t.format === 'sixmans' ? [{ id: 'sixmans' as Tab, label: '6mans' }] : []),
    { id: 'matches', label: 'Matches' }, { id: 'people', label: 'Admins & access' }, { id: 'log', label: 'Activity' },
  ];
  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <Link to={`/t/${t.id}`}>← Public page</Link>
          <h1 style={{ marginTop: 6 }}>{t.name}</h1>
          <div className="row"><StateBadge state={t.state} /><span className="muted small">{t.formatLabel} · {t.teamSize}v{t.teamSize} · {d.guild?.name}</span></div>
        </div>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'control' && <Control d={d} reload={reload} />}
      {tab === 'settings' && <Settings d={d} reload={reload} />}
      {tab === 'entries' && <Entries d={d} reload={reload} />}
      {tab === 'sixmans' && <SixmansAdmin d={d} reload={reload} />}
      {tab === 'matches' && <MatchesAdmin d={d} reload={reload} />}
      {tab === 'people' && <People d={d} reload={reload} />}
      {tab === 'log' && <Activity d={d} />}
    </div>
  );
}

function Control({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const m = d.manager;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const act = async (a: TransitionAction, reason?: string) => {
    const r = await run(() => api<{ state: string; warnings: string[] }>(`/api/tournaments/${t.id}/actions/${a}`, { body: { reason } }));
    if (r) {
      toast(`Now ${STATE_LABELS[r.state as 'draft']}${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}`);
      reload();
    }
  };
  const sc = m.startCheck;
  return (
    <div className="grid cols-2">
      <div className="stack">
        <div className="card">
          <h3>Lifecycle</h3>
          <p className="muted small">Draft → Published → Registration open → Registration closed → In progress → Completed. Format and structure lock when the tournament starts.</p>
          <div className="row">
            {m.availableActions.filter((a: string) => a !== 'cancel').map((a: TransitionAction) =>
              a === 'start' ? (
                <ConfirmButton key={a} className="btn primary" label={ACTION_LABEL[a]} disabled={busy || (sc && !sc.ok)} confirm={`Start now? Brackets/pairings are generated and the format becomes locked.${sc?.warnings.length ? ` Warnings: ${sc.warnings.join(' ')}` : ''}`} onConfirm={() => act(a)} />
              ) : (
                <button key={a} className={a === 'pause' ? 'btn' : 'btn blue'} disabled={busy} onClick={() => act(a)}>{ACTION_LABEL[a] ?? a}</button>
              ),
            )}
            {m.availableActions.includes('cancel') && <ConfirmButton className="btn danger" label="Cancel" reason="optional" confirm="Cancel the tournament? Open matches are cancelled, voice channels removed and participants notified." onConfirm={(r) => act('cancel', r)} />}
          </div>
          <ErrorBox error={error} />
          {t.autoStartError && <div className="alert error" style={{ marginTop: 10 }}>Automatic start failed: {t.autoStartError.split('|').slice(1).join('|')}</div>}
        </div>
        {sc && (
          <div className="card">
            <h3>Start checklist</h3>
            {sc.ok ? <div className="alert ok">Ready to start with {sc.entrants} {t.format === 'sixmans' ? 'players' : 'entrants'}.</div> : <div className="alert error"><strong>Cannot start yet:</strong><ul>{sc.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></div>}
            {sc.warnings.length > 0 && <div className="alert warn" style={{ marginTop: 8 }}><ul>{sc.warnings.map((p: string) => <li key={p}>{p}</li>)}</ul></div>}
          </div>
        )}
      </div>
      <div className="stack">
        {m.unreachable.length > 0 && (
          <div className="card">
            <h3>⚠️ Players who won’t get notifications</h3>
            <ul className="small">{m.unreachable.map((u: any) => <li key={u.userId}><strong>{u.name}</strong>: {u.reason}</li>)}</ul>
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <h3>Voice channels</h3>
            <button className="btn small" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/voice/repair`, { body: {} }))) { toast('Voice channels reconciled'); reload(); } }}>Repair</button>
          </div>
          {!t.config.voice.enabled ? <p className="muted small">Disabled for this tournament.</p> : m.voice.length === 0 ? <p className="muted small">No match channels right now. They are created when a match becomes ready and deleted when it completes.</p> : (
            <div className="table-wrap"><table className="table"><tbody>
              {m.voice.map((v: any) => <tr key={v.id}><td>#{v.matchId}{v.slot.toUpperCase()}</td><td className="mono small">{v.name}</td><td><span className={`badge ${v.status === 'active' ? 'green' : v.status === 'failed' ? 'red' : ''}`}>{v.status}</span></td><td className="small muted">{v.error}</td></tr>)}
            </tbody></table></div>
          )}
        </div>
        <div className="card">
          <h3>Recent notifications</h3>
          {m.notifications.length === 0 ? <p className="muted small">None yet.</p> : (
            <div className="table-wrap"><table className="table"><tbody>
              {m.notifications.slice(0, 15).map((n: any) => <tr key={n.id}><td className="small">{n.category.replace(/_/g, ' ')}</td><td className="small muted">{fmtDate(n.runAt)}</td><td><span className={`badge ${n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : n.status === 'pending' ? 'blue' : ''}`}>{n.status}</span></td><td className="tiny muted">{n.lastError}</td></tr>)}
            </tbody></table></div>
          )}
        </div>
      </div>
    </div>
  );
}

function Settings({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const toast = useToast();
  const [cfg, setCfg] = useState(t.config);
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? '');
  const [visibility, setVisibility] = useState(t.visibility);
  const [channels, setChannels] = useState<any[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [presetName, setPresetName] = useState('');
  const { busy, error, run } = useAsync();
  const locked = !!t.startedAt;
  useEffect(() => {
    if (!d.guild) return;
    api<any[]>(`/api/guilds/${d.guild.id}/channels`).then(setChannels).catch(() => setChannels([]));
    api<any[]>(`/api/guilds/${d.guild.id}/presets`).then(setPresets).catch(() => setPresets([]));
  }, [d.guild]);
  useEffect(() => setCfg(t.config), [t.version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="card">
        <div className="form-grid">
          <Field help={HELP.name} label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field help={HELP.visibility} label="Visibility"><select value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="public">Public</option><option value="private">Private</option></select></Field>
        </div>
        <div style={{ marginTop: 12 }}><Field help={HELP.description} label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field></div>
      </div>
      <div className="card"><ConfigForm cfg={cfg} onChange={setCfg} locked={locked} channels={channels} playerCount={d.entries.filter((e: any) => e.status === 'confirmed').length} /></div>
      <ErrorBox error={error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={busy} onClick={async () => {
          if (await run(() => api(`/api/tournaments/${t.id}`, { method: 'PATCH', body: { name, description, visibility, configPatch: cfg, expectedVersion: t.version } }))) { toast('Settings saved'); reload(); }
        }}>Save settings</button>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3>Apply a preset</h3>
          {locked ? <p className="muted small">Presets can only be applied before the tournament starts.</p> : presets.length === 0 ? <p className="muted small">This server has no presets yet.</p> : (
            <div className="row">
              <select onChange={async (e) => { const id = Number(e.target.value); if (!id) return; const r = await run(() => api(`/api/tournaments/${t.id}/preset-preview`, { body: { presetId: id } })); if (r) setPreview({ ...r, presetId: id }); }} defaultValue="">
                <option value="">Choose a preset to preview…</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="card">
          <h3>Save as preset</h3>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} />
            <button className="btn" disabled={busy || presetName.trim().length < 2} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/save-as-preset`, { body: { name: presetName } }))) { toast('Preset saved'); setPresetName(''); } }}>Save</button>
          </div>
          <p className="muted tiny" style={{ marginTop: 6 }}>Requires preset-manager permission in this server.</p>
        </div>
      </div>
      {preview && (
        <Modal title="Apply preset?" onClose={() => setPreview(null)}>
          {preview.changes.length === 0 ? <p>No settings would change.</p> : (
            <>
              <p>{preview.changes.length} setting(s) will change:</p>
              <div className="table-wrap" style={{ maxHeight: 320 }}>
                <table className="table"><thead><tr><th>Setting</th><th>Now</th><th>Preset</th></tr></thead><tbody>
                  {preview.changes.map((c: any) => <tr key={c.path}><td className="mono small">{c.path}</td><td className="small">{JSON.stringify(c.before)}</td><td className="small team-b">{JSON.stringify(c.after)}</td></tr>)}
                </tbody></table>
              </div>
              {preview.warnings?.length > 0 && <div className="alert warn" style={{ marginTop: 8 }}><ul>{preview.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}
            </>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn primary" disabled={!preview.changes.length || busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/apply-preset`, { body: { presetId: preview.presetId } }))) { toast('Preset applied'); setPreview(null); reload(); } }}>Apply</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Entries({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [replace, setReplace] = useState<{ out: string; in: { id: string; displayName: string } | null }>({ out: '', in: null });
  const started = !!t.startedAt;
  const six = t.format === 'sixmans';
  const act = async (fn: () => Promise<unknown>, msg = 'Saved') => { if (await run(fn)) { toast(msg); reload(); } };
  const statusOrder = ['pending', 'confirmed', 'waitlisted', 'rejected', 'withdrawn', 'removed', 'no_show'];
  const entries = [...d.entries].sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  const allPlayers = d.competitors.flatMap((c: any) => c.players);
  // Availability of everyone on a confirmed registration (players, or each team member).
  const signedUp = d.entries.filter((e: any) => e.status === 'confirmed').flatMap((e: any) => (e.kind === 'team' ? e.members : [{ userId: e.userId, availability: e.availability }]));
  const availCounts = AVAILABILITY_ORDER.map((s) => [s, signedUp.filter((m: any) => (m.availability ?? 'not_asked') === s).length] as const).filter(([, n]) => n > 0);
  const setAvail = (userId: string, answer: string) => act(() => api(`/api/tournaments/${t.id}/availability`, { body: { userId, answer } }), 'Availability saved');
  // Organizers can send the start reminder (with the "can you still make it?" buttons) by hand.
  const canRemind = !started && t.state !== 'cancelled' && !!t.startAt;
  const remind = async (userId: string | null, name?: string) => {
    const r = await run(() => api<{ recipients: number }>(`/api/tournaments/${t.id}/availability-check`, { body: { userId } }));
    if (r) toast(userId ? `Reminder sent to ${name}` : `Reminder sent to ${r.recipients} player${r.recipients === 1 ? '' : 's'}`);
  };
  return (
    <div className="stack">
      {!started && d.guild && (
        <div className="card">
          <h3>Add a player</h3>
          <MemberPicker guildId={d.guild.id} onPick={(u) => act(() => api(`/api/tournaments/${t.id}/players`, { body: { userId: u.id, username: u.username } }), `Added ${u.displayName}`)} />
          <p className="muted tiny" style={{ marginTop: 6 }}>Organizer-added players skip approval but still count toward capacity.</p>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="card">
        <div className="card-head">
          <h3>Registrations</h3>
          <div className="row">
            {canRemind && signedUp.length > 0 && (
              <ConfirmButton className="btn small primary" label="📨 Send availability check to all" confirm="DM every registered player the start reminder now, with the “Can you still make it?” buttons? Players who turned off bot DMs or muted this tournament are skipped." onConfirm={() => remind(null)} />
            )}
            {t.config.registrationMode === 'team' && t.teamSize > 1 && !started && (
              <>
                <button className="btn small" onClick={() => act(() => api(`/api/tournaments/${t.id}/roster-lock`, { body: { locked: true } }), 'Rosters locked')}>Lock rosters</button>
                <button className="btn small ghost" onClick={() => act(() => api(`/api/tournaments/${t.id}/roster-lock`, { body: { locked: false } }), 'Rosters unlocked')}>Unlock</button>
              </>
            )}
          </div>
        </div>
        {signedUp.length > 0 && !started && (
          <div className="row small" style={{ marginBottom: 10, gap: 8 }}>
            <span className="muted">Can they make it?<Help text="Players answer with the buttons in their start reminder DMs, or on the tournament page. You can send that reminder now with the buttons here (to everyone, or 📨 Send next to a player). Anyone who has not answered a day after the reminder turns orange (maybe) and you get a DM. You can also set it here if a player told you directly. 24 hours before the start, organizers get this list by DM." /></span>
            {availCounts.map(([s, n]) => <span key={s} className="row" style={{ gap: 4 }}><AvailabilityBadge status={s} /> {n}</span>)}
          </div>
        )}
        {entries.length === 0 ? <Empty icon="👥" title="No registrations yet" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>Can make it?</th>{t.config.checkIn.enabled && <th>Check-in</th>}<th>{six && t.config.sixmans.skillMethod === 'rank' ? 'Rank' : 'Seed'}</th><th /></tr></thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id}>
                    <td><strong>{e.name}</strong>{e.kind === 'team' && <div className="tiny muted">{e.members.map((m: any) => `${m.name}${m.role === 'captain' ? ' (C)' : m.role === 'substitute' ? ' (sub)' : ''}`).join(', ')}</div>}</td>
                    <td><span className="badge">{e.status}</span></td>
                    <td>
                      {!['pending', 'confirmed', 'waitlisted'].includes(e.status) ? '—' : (
                        <div className="stack" style={{ gap: 4 }}>
                          {(e.kind === 'team' ? e.members : [{ userId: e.userId, name: null, availability: e.availability }]).map((m: any) => (
                            <div key={m.userId} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                              {m.name && <span className="tiny muted">{m.name}</span>}
                              <AvailabilityBadge status={m.availability} />
                              {!started && (
                                <select aria-label="Set availability" className="tiny" value="" disabled={busy} onChange={(ev) => ev.target.value && void setAvail(m.userId, ev.target.value)} style={{ width: 'auto', padding: '2px 4px' }}>
                                  <option value="">Set…</option>
                                  <option value="confirmed">Confirmed</option>
                                  <option value="declined">Can’t make it</option>
                                </select>
                              )}
                              {canRemind && (
                                <button className="btn small ghost" disabled={busy} title="DM the start reminder with the “Can you still make it?” buttons" onClick={() => void remind(m.userId, m.name ?? e.name)}>📨 Send</button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    {t.config.checkIn.enabled && <td>{e.checkedIn ? '✅' : e.status === 'confirmed' && !started ? <button className="btn small ghost" disabled={busy} onClick={() => act(() => api(`/api/tournaments/${t.id}/check-in`, { body: { entryId: e.id } }), 'Checked in')}>Check in</button> : '—'}</td>}
                    <td>
                      {six && t.config.sixmans.skillMethod === 'rank' ? (
                        <select disabled={started} value={e.rank ?? ''} onChange={(ev) => act(() => api(`/api/entries/${e.id}`, { method: 'PATCH', body: { rank: ev.target.value || null } }))} style={{ minWidth: 150 }}>
                          <option value="">— none —</option>
                          {RANKS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      ) : (
                        <input type="number" min={1} disabled={started} defaultValue={e.seed ?? ''} style={{ width: 80 }} onBlur={(ev) => { const v = ev.target.value === '' ? null : Number(ev.target.value); if (v !== e.seed) void act(() => api(`/api/entries/${e.id}`, { method: 'PATCH', body: { seed: v } })); }} />
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {e.status === 'pending' && <button className="btn small blue" disabled={busy} onClick={() => act(() => api(`/api/entries/${e.id}/approve`, { body: {} }), 'Approved')}>Approve</button>}
                        {e.status === 'pending' && <ConfirmButton className="btn small danger" label="Reject" reason="optional" confirm={`Reject ${e.name}?`} onConfirm={(r) => act(() => api(`/api/entries/${e.id}/reject`, { body: { reason: r || null } }), 'Rejected')} />}
                        {e.status === 'waitlisted' && <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/entries/${e.id}/approve`, { body: {} }), 'Promoted')}>Promote</button>}
                        {['confirmed', 'waitlisted'].includes(e.status) && !started && <ConfirmButton className="btn small danger" label="Remove" reason="optional" confirm={`Remove ${e.name} from the tournament?`} onConfirm={(r) => act(() => api(`/api/entries/${e.id}/remove`, { body: { reason: r || null } }), 'Removed')} />}
                        {['rejected', 'removed', 'withdrawn'].includes(e.status) && !started && <button className="btn small ghost" onClick={() => act(() => api(`/api/entries/${e.id}/restore`, { body: {} }), 'Restored')}>Restore</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {started && d.guild && (
        <div className="card">
          <h3>Replace a player</h3>
          <p className="muted small">Swap a player who dropped out for a substitute. Past results stay with the team; for 6mans the no-repeated-trio rule is re-checked.</p>
          <div className="form-grid">
            <Field label="Player leaving">
              <select value={replace.out} onChange={(e) => setReplace({ ...replace, out: e.target.value })}>
                <option value="">Choose…</option>
                {allPlayers.filter((p: any, i: number, arr: any[]) => arr.findIndex((x) => x.userId === p.userId) === i).map((p: any) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Replacement">{replace.in ? <div className="row"><strong>{replace.in.displayName}</strong><button className="btn small ghost" onClick={() => setReplace({ ...replace, in: null })}>change</button></div> : <MemberPicker guildId={d.guild.id} onPick={(u) => setReplace({ ...replace, in: u })} />}</Field>
          </div>
          <div className="spacer" />
          <ConfirmButton className="btn" label="Replace" disabled={!replace.out || !replace.in} reason="required" confirm="Replace this player in every remaining match?" onConfirm={(r) => act(() => api(`/api/tournaments/${t.id}/roster/replace`, { body: { outUserId: replace.out, inUserId: replace.in!.id, reason: r } }), 'Player replaced')} />
        </div>
      )}
    </div>
  );
}

function MatchesAdmin({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [sw, setSw] = useState({ matchA: '', slotA: 'a', matchB: '', slotB: 'a', reason: '' });
  const attention = d.matches.filter((m: any) => ['disputed', 'awaiting_confirmation'].includes(m.status));
  return (
    <div className="stack">
      {attention.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--yellow)' }}>
          <h3>Needs attention</h3>
          {attention.map((m: any) => <div key={m.id} className="row" style={{ marginBottom: 6 }}><MatchBadge status={m.status} /><Link to={`/m/${m.id}`}>#{m.id} {m.label}: {m.a?.name} vs {m.b?.name}</Link></div>)}
        </div>
      )}
      <div className="card">
        <h3>All matches</h3>
        <div className="table-wrap"><table className="table"><tbody>
          {d.matches.filter((m: any) => m.status !== 'void').map((m: any) => (
            <tr key={m.id}><td className="mono">{m.id}</td><td><Link to={`/m/${m.id}`}>{m.label}</Link></td><td>{m.a?.name ?? 'TBD'} vs {m.b?.name ?? (m.walkover ? 'bye' : 'TBD')}</td><td>{m.status === 'completed' ? (m.walkover ? 'bye' : m.forfeit ? 'FF' : `${m.winsA}–${m.winsB}`) : ''}</td><td><MatchBadge status={m.status} /></td></tr>
          ))}
        </tbody></table></div>
      </div>
      {t.startedAt && t.format !== 'sixmans' && (
        <div className="card">
          <h3>Swap bracket positions</h3>
          <p className="muted small">Move entrants between unplayed first-round (or current Swiss round) slots, e.g. to fix seeding. Recorded in the audit log.</p>
          <div className="form-grid">
            <Field label="Match A #"><input value={sw.matchA} onChange={(e) => setSw({ ...sw, matchA: e.target.value })} /></Field>
            <Field label="Slot"><select value={sw.slotA} onChange={(e) => setSw({ ...sw, slotA: e.target.value })}><option value="a">A (blue)</option><option value="b">B (orange)</option></select></Field>
            <Field label="Match B #"><input value={sw.matchB} onChange={(e) => setSw({ ...sw, matchB: e.target.value })} /></Field>
            <Field label="Slot"><select value={sw.slotB} onChange={(e) => setSw({ ...sw, slotB: e.target.value })}><option value="a">A (blue)</option><option value="b">B (orange)</option></select></Field>
            <Field label="Reason"><input value={sw.reason} onChange={(e) => setSw({ ...sw, reason: e.target.value })} /></Field>
          </div>
          <ErrorBox error={error} />
          <div className="spacer" />
          <button className="btn" disabled={busy || !sw.matchA || !sw.matchB || sw.reason.length < 3} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/bracket/swap`, { body: { matchA: Number(sw.matchA), slotA: sw.slotA, matchB: Number(sw.matchB), slotB: sw.slotB, reason: sw.reason } }))) { toast('Swapped'); reload(); } }}>Swap</button>
        </div>
      )}
    </div>
  );
}

function People({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const toast = useToast();
  const { error, run } = useAsync();
  const act = async (fn: () => Promise<unknown>, msg: string) => { if (await run(fn)) { toast(msg); reload(); } };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Tournament admins</h3>
        <p className="muted small">Admins can manage everything except the admin list. Only the creator ({t.createdBy.name}) can add or remove admins.</p>
        {t.admins.length === 0 && <p className="muted">No extra admins.</p>}
        {t.admins.map((a: any) => (
          <div key={a.id} className="row between" style={{ marginBottom: 6 }}>
            <span>{a.name}</span>
            {d.viewer.isCreator && <button className="btn small danger" onClick={() => act(() => api(`/api/tournaments/${t.id}/admins/${a.id}`, { method: 'DELETE', body: {} }), 'Admin removed')}>Remove</button>}
          </div>
        ))}
        {d.viewer.isCreator && d.guild && <MemberPicker guildId={d.guild.id} placeholder="Add an admin…" onPick={(u) => act(() => api(`/api/tournaments/${t.id}/admins`, { body: { userId: u.id } }), `${u.displayName} is now an admin`)} />}
      </div>
      <div className="card">
        <h3>Private access</h3>
        {t.visibility !== 'private' ? <p className="muted small">This tournament is public: anyone can view it. Make it private in Settings to restrict viewing to organizers, participants and invited members.</p> : (
          <>
            <p className="muted small">Invited members can view (and register for) this private tournament.</p>
            {d.guild && <MemberPicker guildId={d.guild.id} placeholder="Invite a viewer…" onPick={(u) => act(() => api(`/api/tournaments/${t.id}/invites`, { body: { userId: u.id } }), `${u.displayName} invited`)} />}
          </>
        )}
        <div className="hr" />
        <h3>Danger zone</h3>
        <div className="row">
          {t.state === 'draft' && d.viewer.isCreator && <ConfirmButton className="btn danger" label="Delete draft" confirm="Delete this draft permanently?" onConfirm={async () => { await api(`/api/tournaments/${t.id}`, { method: 'DELETE', body: {} }); location.hash = '#/'; }} />}
          {['completed', 'cancelled'].includes(t.state) && d.viewer.isCreator && <button className="btn" onClick={() => act(() => api(`/api/tournaments/${t.id}/archive`, { body: { archived: !t.archived } }), t.archived ? 'Unarchived' : 'Archived')}>{t.archived ? 'Unarchive' : 'Archive'}</button>}
        </div>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

function Activity({ d }: { d: any }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    api<any[]>(`/api/tournaments/${d.tournament.id}/audit`).then(setRows).catch(setErr);
  }, [d.tournament.id, d.tournament.version]);
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Spinner />;
  return (
    <div className="card">
      <h3>Audit log</h3>
      <p className="muted small">Every organizer action, result report, confirmation, dispute and correction. Entries cannot be edited or deleted.</p>
      <div className="table-wrap"><table className="table"><tbody>
        {rows.map((r) => (
          <tr key={r.id}><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</td><td className="small">{r.actorName}</td><td><span className="badge">{r.action}</span></td><td className="tiny muted mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.target} {JSON.stringify(r.details)}</td></tr>
        ))}
      </tbody></table></div>
    </div>
  );
}
