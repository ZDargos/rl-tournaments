import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { defaultConfig } from '@rl/core';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { ConfirmButton, Empty, ErrorBox, Field, Check, Spinner, useToast } from '../components/ui';
import { ConfigForm } from '../components/ConfigForm';
import { TournamentCard } from './Home';

const ids = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^\d{5,25}$/.test(x));

export function ServerPage() {
  const { gid } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [g, setG] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [tournaments, setTournaments] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const { busy, error, run } = useAsync();
  const load = () => {
    api<any>(`/api/guilds/${gid}`).then((x) => {
      setG(x);
      setForm({
        announcementChannelId: x.announcementChannelId ?? '', voiceCategoryId: x.voiceCategoryId ?? '', ...x.policy,
        creatorRoleIds: x.policy.creatorRoleIds.join(', '), presetManagerRoleIds: x.policy.presetManagerRoleIds.join(', '),
      });
    }).catch(setErr);
    api<any[]>(`/api/guilds/${gid}/channels`).then(setChannels).catch(() => setChannels([]));
    api<any[]>(`/api/guilds/${gid}/presets`).then(setPresets).catch(() => setPresets([]));
    api<any[]>(`/api/tournaments?guildId=${gid}`).then(setTournaments).catch(() => setTournaments([]));
  };
  useEffect(load, [gid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <ErrorBox error={err} />;
  if (!g || !form) return <Spinner />;
  const text = channels.filter((c) => c.type === 'text');
  const cats = channels.filter((c) => c.type === 'category');
  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          {g.iconUrl ? <img src={g.iconUrl} alt="" width={48} height={48} style={{ borderRadius: 12 }} /> : null}
          <h1>{g.name}</h1>
        </div>
        {g.canCreate && <Link className="btn primary" to={`/create?guild=${g.id}`}>New tournament</Link>}
      </div>
      {!g.botPresent && <div className="alert warn">The bot is not in this server, so voice channels, announcements and DMs won’t work. Ask a server admin to invite it (see the setup guide).</div>}
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>Presets</h3>{g.canManagePresets && <button className="btn small" disabled={busy} onClick={async () => { const p = await run(() => api<any>(`/api/guilds/${g.id}/presets`, { body: { name: `New preset ${presets.length + 1}`, config: defaultConfig() } })); if (p) nav(`/presets/${p.id}`); }}>New preset</button>}</div>
          {presets.length === 0 ? <p className="muted small">No presets yet. Presets save a full set of tournament settings to reuse; a tournament keeps its own snapshot, so editing a preset never changes existing tournaments.</p> : (
            <div className="stack">{presets.map((p) => <Link key={p.id} to={`/presets/${p.id}`} className="row between"><span><strong>{p.name}</strong> <span className="muted small">v{p.version}</span></span><span className="muted small">{p.description}</span></Link>)}</div>
          )}
        </div>
        <div className="card">
          <h3>Server settings</h3>
          {!g.isAdmin ? <p className="muted small">Only members with Manage Server can change these.</p> : (
            <div className="stack">
              <Field label="Default announcement channel">
                <select value={form.announcementChannelId} onChange={(e) => setForm({ ...form, announcementChannelId: e.target.value })}>
                  <option value="">None</option>{text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
              </Field>
              <Field label="Voice channel category">
                <select value={form.voiceCategoryId} onChange={(e) => setForm({ ...form, voiceCategoryId: e.target.value })}>
                  <option value="">None (top level)</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Who can create tournaments">
                <select value={form.tournamentCreation} onChange={(e) => setForm({ ...form, tournamentCreation: e.target.value })}>
                  <option value="admins">Server admins only</option><option value="roles">Admins and specific roles</option><option value="members">Any member</option>
                </select>
              </Field>
              {form.tournamentCreation === 'roles' && <Field label="Creator role IDs" hint="Comma separated. In Discord: Developer Mode → right-click role → Copy Role ID."><input value={form.creatorRoleIds} onChange={(e) => setForm({ ...form, creatorRoleIds: e.target.value })} /></Field>}
              <Field label="Preset manager role IDs" hint="Server admins can always manage presets."><input value={form.presetManagerRoleIds} onChange={(e) => setForm({ ...form, presetManagerRoleIds: e.target.value })} /></Field>
              <Check label="Server admins can manage every tournament in this server" checked={form.serverAdminsManageTournaments} onChange={(v) => setForm({ ...form, serverAdminsManageTournaments: v })} />
              <Check label="Server admins can view private tournaments" checked={form.serverAdminsViewPrivate} onChange={(v) => setForm({ ...form, serverAdminsViewPrivate: v })} />
              <ErrorBox error={error} />
              <button className="btn primary" disabled={busy} onClick={async () => {
                const r = await run(() => api(`/api/guilds/${g.id}/settings`, { method: 'PATCH', body: {
                  announcementChannelId: form.announcementChannelId || null, voiceCategoryId: form.voiceCategoryId || null,
                  policy: { tournamentCreation: form.tournamentCreation, creatorRoleIds: ids(form.creatorRoleIds), presetManagerRoleIds: ids(form.presetManagerRoleIds), serverAdminsManageTournaments: form.serverAdminsManageTournaments, serverAdminsViewPrivate: form.serverAdminsViewPrivate },
                } }));
                if (r) { toast('Server settings saved'); load(); }
              }}>Save</button>
            </div>
          )}
        </div>
      </div>
      <h2>Tournaments</h2>
      {tournaments.length === 0 ? <Empty title="No tournaments in this server yet" /> : <div className="grid cols-3">{tournaments.map((t) => <TournamentCard key={t.id} t={t} />)}</div>}
    </div>
  );
}

export function PresetPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [g, setG] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const { busy, error, run } = useAsync();
  const load = () => api<any>(`/api/presets/${id}`).then((x) => {
    setP(x);
    api<any>(`/api/guilds/${x.guildId}`).then(setG).catch(() => setG(null));
    api<any[]>(`/api/guilds/${x.guildId}/channels`).then(setChannels).catch(() => setChannels([]));
  }).catch(setErr);
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <ErrorBox error={err} />;
  if (!p) return <Spinner />;
  const canEdit = !!g?.canManagePresets;
  return (
    <div className="stack">
      <Link to={`/s/${p.guildId}`}>← {g?.name ?? 'Server'}</Link>
      <div className="card">
        <div className="form-grid">
          <Field label="Preset name"><input value={p.name} disabled={!canEdit} onChange={(e) => setP({ ...p, name: e.target.value })} maxLength={60} /></Field>
          <Field label="Description"><input value={p.description ?? ''} disabled={!canEdit} onChange={(e) => setP({ ...p, description: e.target.value })} maxLength={500} /></Field>
        </div>
        <p className="muted tiny" style={{ marginTop: 6 }}>Version {p.version}. Tournaments created from this preset keep a snapshot; changes here only reach a tournament if an organizer re-applies it before it starts.</p>
      </div>
      <div className="card"><ConfigForm cfg={p.config} onChange={(c) => setP({ ...p, config: c })} locked={!canEdit} channels={channels} /></div>
      <ErrorBox error={error} />
      {canEdit && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <ConfirmButton className="btn danger" label="Delete" confirm="Delete this preset? Existing tournaments are not affected." onConfirm={async () => { if (await run(() => api(`/api/presets/${p.id}`, { method: 'DELETE', body: {} }))) nav(`/s/${p.guildId}`); }} />
          <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api<any>(`/api/presets/${p.id}/duplicate`, { body: {} })); if (r) { toast('Duplicated'); nav(`/presets/${r.id}`); } }}>Duplicate</button>
          <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => api<any>(`/api/presets/${p.id}`, { method: 'PATCH', body: { name: p.name, description: p.description ?? '', config: p.config } })); if (r) { toast('Preset saved'); setP(r); } }}>Save preset</button>
        </div>
      )}
    </div>
  );
}
