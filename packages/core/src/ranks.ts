/**
 * Rocket League competitive ranks and their numeric skill mapping.
 *
 * Ranks are ordered from lowest (Bronze I) to highest (Supersonic Legend). The default
 * numeric value is the 1-based index in RANKS multiplied by 4, plus (division - 1) when a
 * division (I-IV) is given. So "Diamond II div III" = 14*4 + 2 = 58. Values are only ever
 * compared numerically - never as strings. Organizers can override values per tournament
 * via `sixmans.rankValues` (rank id -> number).
 */
export const RANKS = [
  { id: 'bronze_1', label: 'Bronze I' },
  { id: 'bronze_2', label: 'Bronze II' },
  { id: 'bronze_3', label: 'Bronze III' },
  { id: 'silver_1', label: 'Silver I' },
  { id: 'silver_2', label: 'Silver II' },
  { id: 'silver_3', label: 'Silver III' },
  { id: 'gold_1', label: 'Gold I' },
  { id: 'gold_2', label: 'Gold II' },
  { id: 'gold_3', label: 'Gold III' },
  { id: 'platinum_1', label: 'Platinum I' },
  { id: 'platinum_2', label: 'Platinum II' },
  { id: 'platinum_3', label: 'Platinum III' },
  { id: 'diamond_1', label: 'Diamond I' },
  { id: 'diamond_2', label: 'Diamond II' },
  { id: 'diamond_3', label: 'Diamond III' },
  { id: 'champion_1', label: 'Champion I' },
  { id: 'champion_2', label: 'Champion II' },
  { id: 'champion_3', label: 'Champion III' },
  { id: 'grand_champion_1', label: 'Grand Champion I' },
  { id: 'grand_champion_2', label: 'Grand Champion II' },
  { id: 'grand_champion_3', label: 'Grand Champion III' },
  { id: 'supersonic_legend', label: 'Supersonic Legend' },
] as const;

export type RankId = (typeof RANKS)[number]['id'];
export const RANK_IDS = RANKS.map((r) => r.id) as RankId[];

export function isRankId(v: unknown): v is RankId {
  return typeof v === 'string' && (RANK_IDS as string[]).includes(v);
}

export function rankLabel(id: string, division?: number | null): string {
  const r = RANKS.find((x) => x.id === id);
  if (!r) return id;
  return division ? `${r.label} Div ${['I', 'II', 'III', 'IV'][division - 1] ?? division}` : r.label;
}

export function defaultRankValue(id: RankId, division?: number | null): number {
  const idx = RANK_IDS.indexOf(id) + 1;
  const div = division && division >= 1 && division <= 4 ? division - 1 : 0;
  return idx * 4 + div;
}

/** Parse loose user input like "gc2", "Champ 3", "diamond ii", "ssl". */
export function parseRank(input: string): RankId | null {
  const s = input.trim().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  if (isRankId(s.replace(/ /g, '_'))) return s.replace(/ /g, '_') as RankId;
  if (['ssl', 'supersonic', 'supersonic legend'].includes(s)) return 'supersonic_legend';
  const roman: Record<string, string> = { i: '1', ii: '2', iii: '3', '1': '1', '2': '2', '3': '3' };
  const m = s.match(/^(bronze|b|silver|s|gold|g|platinum|plat|p|diamond|diam|d|champion|champ|c|grand champion|grand champ|gc)\s?(i{1,3}|[123])$/);
  if (!m) return null;
  const tierMap: Record<string, string> = {
    bronze: 'bronze', b: 'bronze', silver: 'silver', s: 'silver', gold: 'gold', g: 'gold',
    platinum: 'platinum', plat: 'platinum', p: 'platinum', diamond: 'diamond', diam: 'diamond', d: 'diamond',
    champion: 'champion', champ: 'champion', c: 'champion',
    'grand champion': 'grand_champion', 'grand champ': 'grand_champion', gc: 'grand_champion',
  };
  const id = `${tierMap[m[1]]}_${roman[m[2]]}`;
  return isRankId(id) ? id : null;
}
