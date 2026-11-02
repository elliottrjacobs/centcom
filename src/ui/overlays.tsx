import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check } from './icons';

/* ════════════════════════ Popover ════════════════════════
 * Anchored floating layer. It scales in from the corner nearest its trigger
 * (origin-aware), never from center, and skips the animation entirely when
 * `instant` is set, which is what keyboard-initiated opens use.
 */

export type Anchor = { x: number; y: number; w: number; h: number };
export const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
export const anchorAt = (x: number, y: number): Anchor => ({ x, y, w: 0, h: 0 });

interface PopoverProps {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  instant?: boolean;
  width?: number;
  className?: string;
}

export function Popover({ anchor, onClose, children, align = 'start', instant, width, className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const pad = 8;
    const gap = 4;
    let left = align === 'end' ? anchor.x + anchor.w - w : anchor.x;
    let originX = align === 'end' ? 'right' : 'left';
    if (left + w > window.innerWidth - pad) {
      left = Math.max(pad, anchor.x + anchor.w - w);
      originX = 'right';
    }
    if (left < pad) {
      left = pad;
      originX = 'left';
    }
    let top = anchor.y + anchor.h + gap;
    let originY = 'top';
    if (top + h > window.innerHeight - pad && anchor.y - gap - h > pad) {
      top = anchor.y - gap - h;
      originY = 'bottom';
    }
    top = Math.max(pad, Math.min(top, window.innerHeight - pad - h));
    setPos({ left, top, origin: `${originX} ${originY}` });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so a click that closes the popover doesn't also hit what's beneath.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className ?? ''}`}
      data-instant={instant || undefined}
      data-placed={pos ? '' : undefined}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        transformOrigin: pos?.origin,
      }}
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  );
}

/* ════════════════════════ Menu ════════════════════════ */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  searchable?: boolean;
  placeholder?: string;
  /** Keep the menu open after a selection (multi-select such as labels). */
  sticky?: boolean;
  /** Offer to create a new entry from the typed text. */
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
}

export function Menu({ items, onClose, searchable, placeholder, sticky, onCreate, createLabel }: MenuProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query
    ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()))
    : items;
  const canCreate =
    !!onCreate && query.trim().length > 0 && !items.some((i) => i.label.toLowerCase() === query.trim().toLowerCase());
  const total = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (index: number) => {
    if (canCreate && index === filtered.length) {
      onCreate!(query.trim());
      setQuery('');
      if (!sticky) onClose();
      return;
    }
    const item = filtered[index];
    if (!item || item.disabled) return;
    item.onSelect();
    if (!sticky) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (total ? (a + 1) % total : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (total ? (a - 1 + total) % total : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="menu" onKeyDown={onKeyDown} tabIndex={searchable ? undefined : -1} ref={useAutoFocus(!searchable)}>
      {searchable && (
        <input
          className="menu-search"
          autoFocus
          placeholder={placeholder ?? 'Filter…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="menu-list" ref={listRef} role="menu">
        {filtered.map((item, i) => (
          <div key={item.id}>
            {item.separatorBefore && !query && <div className="menu-sep" />}
            <button
              role="menuitem"
              className="menu-item"
              data-active={i === active}
              data-danger={item.danger || undefined}
              disabled={item.disabled}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {item.icon !== undefined && <span className="menu-icon">{item.icon}</span>}
              <span className="menu-label truncate">{item.label}</span>
              {item.checked && (
                <span className="menu-check">
                  <Check size={14} />
                </span>
              )}
              {item.hint && <kbd className="menu-hint">{item.hint}</kbd>}
            </button>
          </div>
        ))}
        {canCreate && (
          <button
            role="menuitem"
            className="menu-item"
            data-active={active === filtered.length}
            onPointerMove={() => setActive(filtered.length)}
            onClick={() => choose(filtered.length)}
          >
            <span className="menu-label truncate">{createLabel ? createLabel(query.trim()) : `Create “${query.trim()}”`}</span>
          </button>
        )}
        {total === 0 && <div className="menu-empty">No matches</div>}
      </div>
    </div>
  );
}

function useAutoFocus(enabled: boolean) {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (enabled) el?.focus();
    },
    [enabled],
  );
}

/* ════════════════════════ Imperative overlay host ════════════════════════
 * `contextMenu()`, `confirm()`, `prompt()` and `toast()` are callable from
 * anywhere with no provider or hook, and <Overlays /> renders them once.
 */

interface ContextState {
  anchor: Anchor;
  items: MenuItem[];
}
interface ConfirmState {
  kind: 'confirm';
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
interface PromptState {
  kind: 'prompt';
  title: string;
  label?: string;
  initial: string;
  placeholder?: string;
  confirmLabel: string;
  /** Select only the name part, leaving the extension alone. */
  selectStem?: boolean;
  resolve: (value: string | null) => void;
}
interface ToastState {
  id: number;
  message: string;
  tone: 'default' | 'error';
  action?: { label: string; run: () => void };
}

let ctx: ContextState | null = null;
let dialog: ConfirmState | PromptState | null = null;
let toasts: ToastState[] = [];
const subs = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  subs.forEach((s) => s());
};

export function contextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault();
  ctx = { anchor: anchorAt(e.clientX, e.clientY), items };
  bump();
}

export function confirm(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    dialog = { kind: 'confirm', confirmLabel: 'Confirm', ...opts, resolve };
    bump();
  });
}

export function prompt(opts: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  selectStem?: boolean;
}) {
  return new Promise<string | null>((resolve) => {
    dialog = { kind: 'prompt', initial: '', confirmLabel: 'Save', ...opts, resolve };
    bump();
  });
}

let toastId = 0;
export function toast(message: string, opts: { tone?: 'default' | 'error'; action?: ToastState['action'] } = {}) {
  const id = ++toastId;
  toasts = [...toasts, { id, message, tone: opts.tone ?? 'default', action: opts.action }];
  bump();
  window.setTimeout(() => dismissToast(id), opts.action ? 7000 : 3600);
}
export const toastError = (err: unknown) =>
  toast(err instanceof Error ? err.message : 'Something went wrong', { tone: 'error' });

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  bump();
}

export function Overlays() {
  useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => version,
  );

  const closeCtx = useCallback(() => {
    ctx = null;
    bump();
  }, []);

  return (
    <>
      {ctx && (
        <Popover anchor={ctx.anchor} onClose={closeCtx} className="popover-menu">
          <Menu items={ctx.items} onClose={closeCtx} />
        </Popover>
      )}
      {dialog && <DialogHost state={dialog} />}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast" data-tone={t.tone}>
              <span>{t.message}</span>
              {t.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    t.action!.run();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function DialogHost({ state }: { state: ConfirmState | PromptState }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? state.initial : '');
  const inputRef = useRef<HTMLInputElement>(null);

  const finish = (result: boolean | string | null) => {
    dialog = null;
    bump();
    (state.resolve as (v: boolean | string | null) => void)(result);
  };
  const cancel = () => finish(state.kind === 'confirm' ? false : null);
  const submit = () => {
    if (state.kind === 'confirm') return finish(true);
    const v = value.trim();
    if (v) finish(v);
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input || state.kind !== 'prompt') return;
    input.focus();
    const dot = state.selectStem ? state.initial.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : state.initial.length);
  }, [state]);

  return (
    <Modal onClose={cancel} width={400}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="dialog-title">{state.title}</h2>
        {state.kind === 'confirm' && state.body && <p className="dialog-body">{state.body}</p>}
        {state.kind === 'prompt' && (
          <label className="field">
            {state.label && <span className="field-label">{state.label}</span>}
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder={state.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            data-danger={(state.kind === 'confirm' && state.danger) || undefined}
            autoFocus={state.kind === 'confirm'}
            disabled={state.kind === 'prompt' && !value.trim()}
          >
            {state.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ════════════════════════ Modal ════════════════════════
 * Modals are not anchored to a trigger, so they keep a centered origin.
 */
export function Modal({
  children,
  onClose,
  width = 560,
  instant,
  top,
}: {
  children: ReactNode;
  onClose: () => void;
  width?: number;
  instant?: boolean;
  /** Pin near the top (command palette) instead of centering. */
  top?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="scrim"
      data-instant={instant || undefined}
      data-top={top || undefined}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" data-instant={instant || undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ════════════════════════ Trigger helper ════════════════════════ */

/** Button that opens a Popover anchored to itself. */
export function usePopover() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const open = useCallback((el: Element) => setAnchor(anchorOf(el)), []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open, close, isOpen: anchor !== null };
}
