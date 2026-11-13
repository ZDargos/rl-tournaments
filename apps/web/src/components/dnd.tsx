import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { cn } from './ui';

/**
 * Drag and drop for moving players between pools, teams and matches. Drop a name on a group to move
 * it there, or on another name to swap the two. `group` limits where a name can go (for example a
 * schedule round: players only move within their round).
 */

export interface DropResult {
  /** The dragged player. */
  item: string;
  from: string;
  to: string;
  /** Set when the player was dropped on another player: swap the two. */
  swapWith?: string;
}

interface ItemData { kind: 'item'; item: string; zone: string; group?: string; label: ReactNode }
interface ZoneData { kind: 'zone'; zone: string; group?: string }
interface PillTarget { kind: 'pill'; item: string; zone: string; group?: string }

const ActiveCtx = createContext<ItemData | null>(null);

// Names win over the zone around them (so dropping on a name swaps); otherwise the zone under the pointer.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length) {
    const pill = hits.find((h) => (h.data?.droppableContainer?.data.current as PillTarget | undefined)?.kind === 'pill');
    return pill ? [pill] : hits;
  }
  return closestCenter(args);
};

export function DragBoard({ onDrop, disabled, children }: { onDrop: (r: DropResult) => void; disabled?: boolean; children: ReactNode }) {
  const [active, setActive] = useState<ItemData | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const start = (e: DragStartEvent) => {
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('is-dragging');
    setActive((e.active.data.current as ItemData) ?? null);
  };
  const stop = () => { document.body.classList.remove('is-dragging'); setActive(null); };
  const end = (e: DragEndEvent) => {
    stop();
    const from = e.active.data.current as ItemData | undefined;
    const over = e.over?.data.current as ZoneData | PillTarget | undefined;
    if (!from || !over || disabled) return;
    if (from.group !== over.group) return;
    if (over.kind === 'pill') {
      if (over.item === from.item) return;
      onDrop({ item: from.item, from: from.zone, to: over.zone, swapWith: over.item });
    } else if (over.zone !== from.zone) onDrop({ item: from.item, from: from.zone, to: over.zone });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={start} onDragEnd={end} onDragCancel={stop}>
      <ActiveCtx.Provider value={active}>{children}</ActiveCtx.Provider>
      <DragOverlay dropAnimation={null}>{active ? <span className="player-pill drag-overlay">{active.label}</span> : null}</DragOverlay>
    </DndContext>
  );
}

/** A pool, team or sit-out list that names can be dropped into. */
export function DropZone({ zone, group, className, invalid, children, label }: { zone: string; group?: string; className?: string; invalid?: boolean; children: ReactNode; label?: string }) {
  const active = useContext(ActiveCtx);
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${zone}`, data: { kind: 'zone', zone, group } satisfies ZoneData });
  const allowed = !!active && active.group === group;
  return (
    <div ref={setNodeRef} aria-label={label} className={cn('drop-zone', className, allowed && 'drop-ready', allowed && isOver && 'drop-over', invalid && 'drop-invalid')}>
      {children}
    </div>
  );
}

/** A player name that can be dragged, and dropped on to swap. */
export function DragPill({ item, zone, group, label, extra, disabled, className }: { item: string; zone: string; group?: string; label: ReactNode; extra?: ReactNode; disabled?: boolean; className?: string }) {
  const active = useContext(ActiveCtx);
  const drag = useDraggable({ id: `item:${group ?? ''}:${item}`, data: { kind: 'item', item, zone, group, label } satisfies ItemData, disabled });
  const drop = useDroppable({ id: `pill:${group ?? ''}:${item}`, data: { kind: 'pill', item, zone, group } satisfies PillTarget, disabled });
  const swapTarget = !!active && active.item !== item && active.group === group && drop.isOver;
  return (
    <span
      ref={(el) => { drag.setNodeRef(el); drop.setNodeRef(el); }}
      {...drag.attributes}
      {...drag.listeners}
      className={cn('player-pill', !disabled && 'draggable', drag.isDragging && 'dragging', swapTarget && 'swap-target', className)}
      title={disabled ? undefined : 'Drag to another group to move, or onto a player to swap'}
    >
      {label}{extra}
    </span>
  );
}

/** Apply a drop to named lists of players: move to the end of the target, or swap places. */
export function applyDrop(zones: Record<string, string[]>, r: DropResult): Record<string, string[]> {
  const next = Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, [...v]]));
  next[r.from] ??= [];
  next[r.to] ??= [];
  const fromIdx = next[r.from].indexOf(r.item);
  if (fromIdx < 0) return zones;
  if (r.swapWith) {
    const toIdx = next[r.to].indexOf(r.swapWith);
    if (toIdx < 0) return zones;
    next[r.from][fromIdx] = r.swapWith;
    next[r.to][toIdx] = r.item;
  } else {
    next[r.from].splice(fromIdx, 1);
    next[r.to].push(r.item);
  }
  return next;
}
