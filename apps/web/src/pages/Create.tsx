import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { defaultConfig, validateConfig, type TournamentConfig } from '@rl/core';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { ConfigForm } from '../components/ConfigForm';
import { Empty, ErrorBox, Field, Spinner } from '../components/ui';
import { HELP } from '../components/settingHelp';
import { localTz } from '../lib/format';

export function CreatePage() {
  const { me, loading } = useAuth();
  const nav = useNavigate();
  const [guilds, setGuilds] = useState<any[] | null>(null);
  const [guildId, setGuildId] = useState('');
  const [presets, setPresets] = useState<any[]>([]);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [publish, setPublish] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [cfg, setCfg] = useState<TournamentConfig>(() => defaultConfig({ schedule: { timezone: localTz() } }));
  const { busy, error, run } = useAsync();

  useEffect(() => {
    if (me) api<any[]>('/api/me/guilds').then((g) => {
      const can = g.filter((x) => x.canCreate);
      setGuilds(can);
      if (can.length === 1) setGuildId(can[0].id);
    }).catch(() => setGuilds([]));
  }, [me]);
  useEffect(() => {
    if (!guildId) return;
    api<any[]>(`/api/guilds/${guildId}/presets`).then(setPresets).catch(() => setPresets([]));
    api<any[]>(`/api/guilds/${guildId}/channels`).then(setChannels).catch(() => setChannels([]));
  }, [guildId]);

  if (loading) return <Spinner />;
  if (!me) return <Empty icon="🔑" title="Log in to create a tournament"><Link to="/login?returnTo=/create">Log in with Discord</Link></Empty>;
  if (!guilds) return <Spinner />;
  if (!guilds.length)
    return (
      <Empty icon="🛠️" title="You cannot create tournaments in any server yet">
        Tournaments belong to a Discord server. The bot must be in the server, and by default only server admins (Manage Server) can create tournaments. A server admin can allow members or specific roles in the server settings.
      </Empty>
    );
  const problems = validateConfig(cfg);
  return (
    <div className="stack" style={{ maxWidth: 980, margin: '0 auto' }}>
      <h1>Create a tournament</h1>
      <div className="card">
        <div className="form-grid">
          <Field help={HELP.server} label="Discord server">
            <select value={guildId} onChange={(e) => { setGuildId(e.target.value); setPresetId(null); }}>
              <option value="">Choose…</option>
              {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field help={HELP.name} label="Name"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Friday Night 3v3" /></Field>
          <Field help={HELP.visibility} label="Visibility" hint="Private: only organizers, participants and invited members can see it.">
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'public')}><option value="public">Public</option><option value="private">Private</option></select>
          </Field>
          {presets.length > 0 && (
            <Field help={HELP.preset} label="Start from a preset" hint="The preset’s settings are copied; later preset edits do not change this tournament.">
              <select value={presetId ?? ''} onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                setPresetId(id);
                const p = presets.find((x) => x.id === id);
                if (p) setCfg({ ...structuredClone(p.config), schedule: { ...p.config.schedule, timezone: p.config.schedule.timezone || localTz() } });
              }}>
                <option value="">No preset</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <Field help={HELP.description} label="Description (rules, prizes, links)"><textarea value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Settings</h2>
          <label className="check small"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Show all settings</label>
        </div>
        <ConfigForm cfg={cfg} onChange={setCfg} sections={advanced ? 'all' : 'basic'} channels={channels} />
      </div>
      {problems.length > 0 && <div className="alert warn"><strong>Please check:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      <ErrorBox error={error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <label className="check"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish now (visible, registration not open yet)</label>
        <button
          className="btn primary"
          disabled={busy || !guildId || name.trim().length < 3 || problems.length > 0}
          onClick={async () => {
            const r = await run(() => api<{ id: number }>('/api/tournaments', { body: { guildId, name, description, visibility, presetId, config: cfg, publish } }));
            if (r) nav(`/t/${r.id}/manage`);
          }}
        >
          Create tournament
        </button>
      </div>
    </div>
  );
}
