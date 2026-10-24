import { conflict } from './errors.js';

export const STATES = [
  'draft',
  'published',
  'registration_open',
  'registration_closed',
  'ready',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
] as const;
export type TournamentState = (typeof STATES)[number];

export const STATE_LABELS: Record<TournamentState, string> = {
  draft: 'Draft',
  published: 'Published',
  registration_open: 'Registration open',
  registration_closed: 'Registration closed',
  ready: 'Ready to start',
  in_progress: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export type TransitionAction =
  | 'publish'
  | 'unpublish'
  | 'open_registration'
  | 'close_registration'
  | 'mark_ready'
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'cancel';

const TRANSITIONS: Record<TransitionAction, { from: TournamentState[]; to: TournamentState }> = {
  publish: { from: ['draft'], to: 'published' },
  unpublish: { from: ['published'], to: 'draft' },
  open_registration: { from: ['draft', 'published', 'registration_closed', 'ready'], to: 'registration_open' },
  close_registration: { from: ['registration_open'], to: 'registration_closed' },
  mark_ready: { from: ['registration_closed'], to: 'ready' },
  start: { from: ['published', 'registration_open', 'registration_closed', 'ready'], to: 'in_progress' },
  pause: { from: ['in_progress'], to: 'paused' },
  resume: { from: ['paused'], to: 'in_progress' },
  complete: { from: ['in_progress'], to: 'completed' },
  cancel: {
    from: ['draft', 'published', 'registration_open', 'registration_closed', 'ready', 'in_progress', 'paused'],
    to: 'cancelled',
  },
};

export function canTransition(from: TournamentState, action: TransitionAction): boolean {
  return TRANSITIONS[action].from.includes(from);
}

export function nextState(from: TournamentState, action: TransitionAction): TournamentState {
  const t = TRANSITIONS[action];
  if (!t.from.includes(from))
    throw conflict('invalid_transition', `Cannot ${action.replace(/_/g, ' ')} a tournament that is ${STATE_LABELS[from].toLowerCase()}.`);
  return t.to;
}

export function availableActions(from: TournamentState): TransitionAction[] {
  return (Object.keys(TRANSITIONS) as TransitionAction[]).filter((a) => a !== 'complete' && canTransition(from, a));
}

/** Once started, the competition structure is locked. */
export const isStarted = (s: TournamentState) => s === 'in_progress' || s === 'paused' || s === 'completed';
export const isFinished = (s: TournamentState) => s === 'completed' || s === 'cancelled';
export const isRegistrationOpen = (s: TournamentState) => s === 'registration_open';
export const isPreStart = (s: TournamentState) => !isStarted(s) && s !== 'cancelled';
