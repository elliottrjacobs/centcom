import type { TicketPriority, TicketStatus, ProjectStatus } from '@shared/types';

/**
 * Status and priority glyphs. Meaning is carried by shape first and color
 * second, so they still read in grayscale and for color-blind users.
 */

const R = 5.25; // ring radius inside a 14px box
const C = 7;

/** A pie wedge from 12 o'clock sweeping clockwise by `fraction` of a full turn. */
function wedge(fraction: number, r = 3.1) {
  const a = fraction * Math.PI * 2;
  const x = C + r * Math.sin(a);
  const y = C - r * Math.cos(a);
  return `M${C} ${C} L${C} ${C - r} A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

export function StatusIcon({ status, size = 14 }: { status: TicketStatus; size?: number }) {
  const color = `var(--st-${
    { backlog: 'backlog', todo: 'todo', in_progress: 'progress', in_review: 'review', done: 'done', canceled: 'canceled' }[
      status
    ]
  })`;
  const ring = <circle cx={C} cy={C} r={R} fill="none" stroke={color} strokeWidth="1.5" />;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
      {status === 'backlog' && (
        <circle cx={C} cy={C} r={R} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="1.6 1.7" />
      )}
      {status === 'todo' && ring}
      {status === 'in_progress' && (
        <>
          {ring}
          <path d={wedge(0.5)} fill={color} />
        </>
      )}
      {status === 'in_review' && (
        <>
          {ring}
          <path d={wedge(0.75)} fill={color} />
        </>
      )}
      {status === 'done' && (
        <>
          <circle cx={C} cy={C} r={6} fill={color} />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            fill="none"
            stroke="var(--bg-panel)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {status === 'canceled' && (
        <>
          <circle cx={C} cy={C} r={6} fill={color} />
          <path d="M5 5 9 9M9 5 5 9" stroke="var(--bg-panel)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: TicketPriority; size?: number }) {
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
        {[2.5, 6, 9.5].map((x) => (
          <rect key={x} x={x} y="6.25" width="2" height="1.5" rx="0.75" fill="var(--text-4)" />
        ))}
      </svg>
    );
  }
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="var(--pr-urgent)" />
        <rect x="6.25" y="3.75" width="1.5" height="4.25" rx="0.75" fill="#fff" />
        <circle cx="7" cy="9.9" r="0.9" fill="#fff" />
      </svg>
    );
  }
  // 2 high = 3 bars lit, 3 medium = 2, 4 low = 1
  const lit = 5 - priority;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
      {[0, 1, 2].map((i) => {
        const h = 4 + i * 3;
        return (
          <rect
            key={i}
            x={2 + i * 3.75}
            y={12 - h}
            width="2.5"
            height={h}
            rx="1"
            fill={i < lit ? 'var(--pr-bar)' : 'var(--pr-bar-dim)'}
          />
        );
      })}
    </svg>
  );
}

export function ProjectStatusIcon({ status, size = 14 }: { status: ProjectStatus; size?: number }) {
  const map: Record<ProjectStatus, TicketStatus> = {
    backlog: 'backlog',
    planned: 'todo',
    active: 'in_progress',
    paused: 'in_progress',
    completed: 'done',
    canceled: 'canceled',
  };
  if (status === 'paused') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--st-todo)" strokeWidth="1.5" />
        <path d="M5.6 5v4M8.4 5v4" stroke="var(--st-todo)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return <StatusIcon status={map[status]} size={size} />;
}

/** Strikethrough is missing from reicon; drawn to match its 1.5 stroke weight. */
export function StrikeGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M16.5 7.5C16 5.8 14.3 4.75 12 4.75c-2.6 0-4.5 1.4-4.5 3.5 0 1.3.7 2.2 2 2.9M7.25 16c.4 1.9 2.2 3.25 4.75 3.25 2.8 0 4.75-1.5 4.75-3.7 0-.6-.13-1.1-.38-1.55"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M4 12h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
