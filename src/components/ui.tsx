import {
  ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tip?: string;
  shortcut?: string;
  active?: boolean;
  tipSide?: 'bottom' | 'top' | 'right' | 'left';
};

export function IconButton({ tip, shortcut, active, tipSide = 'bottom', className = '', children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'active' : ''} ${className}`}
      aria-label={tip}
      aria-pressed={active}
      data-tip={tip ? (shortcut ? `${tip}  ·  ${shortcut}` : tip) : undefined}
      data-tip-side={tipSide}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Button({
  variant = 'default',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Popover anchored to an element                                       */
/* ------------------------------------------------------------------ */

export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return { open, setOpen, anchor, toggle: () => setOpen((o) => !o), close: () => setOpen(false) };
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  className = '',
  point,
}: {
  anchor?: React.RefObject<HTMLElement | null>;
  point?: { x: number; y: number } | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current.getBoundingClientRect();
    let x: number;
    let y: number;
    if (point) {
      x = point.x;
      y = point.y;
    } else if (anchor?.current) {
      const r = anchor.current.getBoundingClientRect();
      x = align === 'end' ? r.right - el.width : align === 'center' ? r.left + r.width / 2 - el.width / 2 : r.left;
      y = r.bottom + 6;
      if (y + el.height > window.innerHeight - 8) y = Math.max(8, r.top - el.height - 6);
    } else return;
    x = Math.max(8, Math.min(x, window.innerWidth - el.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - el.height - 8));
    setPos({ left: x, top: y });
  }, [open, anchor, align, point]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onClose, anchor]);

  useEffect(() => {
    if (!open) setPos({ visibility: 'hidden' });
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  heading?: string;
}

export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.heading ? (
          <div key={i} className="menu-heading">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            <span className="menu-icon">{it.checked ? <Check size={15} /> : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function MenuButton({
  label,
  icon,
  items,
  tip,
  className = '',
  align = 'start',
  caret = true,
}: {
  label?: ReactNode;
  icon?: ReactNode;
  items: MenuItem[] | (() => MenuItem[]);
  tip?: string;
  className?: string;
  align?: 'start' | 'end';
  caret?: boolean;
}) {
  const p = usePopover();
  return (
    <>
      <button
        ref={p.anchor}
        type="button"
        className={`menu-btn ${p.open ? 'open' : ''} ${className}`}
        onClick={p.toggle}
        data-tip={!p.open ? tip : undefined}
        aria-haspopup="menu"
        aria-expanded={p.open}
      >
        {icon}
        {label && <span>{label}</span>}
        {caret && <ChevronDown size={14} className="caret" />}
      </button>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close} align={align}>
        <MenuList items={typeof items === 'function' ? items() : items} onClose={p.close} />
      </Popover>
    </>
  );
}

/** Right-click menu at a screen point. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  return (
    <Popover open={!!at} point={at} onClose={onClose}>
      <MenuList items={items} onClose={onClose} />
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Colors                                                               */
/* ------------------------------------------------------------------ */

export const PALETTE = [
  '#1a1a1a',
  '#495057',
  '#868e96',
  '#ffffff',
  '#e03131',
  '#f76707',
  '#fcc419',
  '#ffd43b',
  '#2f9e44',
  '#51cf66',
  '#1c7ed6',
  '#4c6ef5',
  '#7048e8',
  '#c2255c',
  '#0c8599',
  '#5c3d2e',
];

export const HIGHLIGHT_PALETTE = ['#ffd43b', '#a9e34b', '#66d9e8', '#ffa8a8', '#e599f7', '#ffc078'];

export function ColorButton({
  value,
  onChange,
  tip,
  allowNone,
  palette = PALETTE,
  kind = 'fill',
}: {
  value: string | null;
  onChange: (c: string | null) => void;
  tip: string;
  allowNone?: boolean;
  palette?: string[];
  kind?: 'fill' | 'stroke' | 'text';
}) {
  const p = usePopover();
  return (
    <>
      <button ref={p.anchor} type="button" className="color-btn" data-tip={!p.open ? tip : undefined} onClick={p.toggle} aria-label={tip}>
        <span className={`swatch swatch-${kind} ${value ? '' : 'none'}`} style={{ '--c': value ?? 'transparent' } as CSSProperties} />
        <ChevronDown size={12} className="caret" />
      </button>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close}>
        <div className="palette">
          <div className="palette-grid">
            {allowNone && (
              <button
                type="button"
                className={`palette-cell none ${value === null ? 'sel' : ''}`}
                onClick={() => {
                  onChange(null);
                  p.close();
                }}
                aria-label="No color"
              />
            )}
            {palette.map((c) => (
              <button
                key={c}
                type="button"
                className={`palette-cell ${value?.toLowerCase() === c ? 'sel' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  onChange(c);
                  p.close();
                }}
                aria-label={c}
              />
            ))}
          </div>
          <label className="palette-custom">
            <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} />
            <span>Custom color…</span>
          </label>
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{format(value)}</span>
    </label>
  );
}

export function SliderButton(props: Parameters<typeof Slider>[0] & { icon: ReactNode; tip: string }) {
  const p = usePopover();
  const { icon, tip, ...slider } = props;
  return (
    <>
      <button ref={p.anchor} type="button" className="menu-btn compact" onClick={p.toggle} data-tip={!p.open ? tip : undefined}>
        {icon}
        <span className="mono-num">{slider.format ? slider.format(slider.value) : slider.value}</span>
        <ChevronDown size={12} className="caret" />
      </button>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close}>
        <div className="slider-pop">
          <Slider {...slider} />
        </div>
      </Popover>
    </>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
          data-tip={o.tip}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                                */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460,
  className = '',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary');
    first?.focus();
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${className}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton tip="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
