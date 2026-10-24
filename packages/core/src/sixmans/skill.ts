import { defaultRankValue, isRankId, type RankId } from '../ranks.js';
import type { TournamentConfig } from '../config.js';

export interface SkillInput {
  id: string;
  /** Manual seed: 1 = strongest. Ties allowed. */
  seed?: number | null;
  rank?: string | null;
  division?: number | null;
}

export interface SkilledPlayer {
  id: string;
  /** Higher = stronger. */
  skill: number;
  /** True when the player had no seed/rank and the missing-skill policy was applied. */
  imputed: boolean;
}

/**
 * Convert the tournament's selected skill input into numbers (higher = stronger).
 *  - manual_seed: skill = (maxSeed + 1) - seed, so seed 1 is strongest and equal seeds tie.
 *  - rank: documented mapping in ranks.ts, optionally overridden by config.sixmans.rankValues.
 * Missing values: "lowest" puts them below every known player, "median" uses the median.
 */
export function computeSkills(players: SkillInput[], cfg: Pick<TournamentConfig, 'sixmans'>): SkilledPlayer[] {
  const method = cfg.sixmans.skillMethod;
  const raw = players.map((p) => {
    if (method === 'manual_seed') {
      return p.seed != null && Number.isFinite(p.seed) && p.seed > 0 ? { id: p.id, v: p.seed } : { id: p.id, v: null };
    }
    if (p.rank && isRankId(p.rank)) {
      const override = cfg.sixmans.rankValues[p.rank as RankId];
      const v = override != null ? override + (p.division ? (p.division - 1) / 4 : 0) : defaultRankValue(p.rank as RankId, p.division);
      return { id: p.id, v };
    }
    return { id: p.id, v: null };
  });
  const known = raw.filter((r) => r.v != null).map((r) => r.v as number);
  let values: { id: string; skill: number | null }[];
  if (method === 'manual_seed') {
    const maxSeed = known.length ? Math.max(...known) : 0;
    values = raw.map((r) => ({ id: r.id, skill: r.v == null ? null : maxSeed + 1 - r.v }));
  } else values = raw.map((r) => ({ id: r.id, skill: r.v }));
  const knownSkills = values.filter((v) => v.skill != null).map((v) => v.skill as number).sort((a, b) => a - b);
  let fill = 0;
  if (knownSkills.length) {
    if (cfg.sixmans.missingSkill === 'median') {
      const mid = Math.floor(knownSkills.length / 2);
      fill = knownSkills.length % 2 ? knownSkills[mid] : (knownSkills[mid - 1] + knownSkills[mid]) / 2;
    } else fill = knownSkills[0] - 1;
  }
  return values.map((v) => ({ id: v.id, skill: v.skill ?? fill, imputed: v.skill == null }));
}
