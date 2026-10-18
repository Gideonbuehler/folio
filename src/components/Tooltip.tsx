import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One tooltip for the whole app, driven by `data-tip` attributes. Rendered in
 * a portal so scrolling toolbars and panels can't clip it.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: string } | null>(null);
  const timer = useRef(0);
  const current = useRef<Element | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (el === current.current) return;
      hide();
      if (!el) return;
      const text = el.getAttribute('data-tip');
      if (!text) return;
      current.current = el;
      timer.current = window.setTimeout(() => {
        if (current.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const side = el.getAttribute('data-tip-side') || 'bottom';
        const x = side === 'right' ? r.right + 8 : side === 'left' ? r.left - 8 : r.left + r.width / 2;
        const y = side === 'top' ? r.top - 8 : side === 'bottom' ? r.bottom + 8 : r.top + r.height / 2;
        setTip({ text, x, y, side });
      }, 450);
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide, true);
    return () => {
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide, true);
    };
  }, []);

  useEffect(() => {
    if (!tip || !ref.current) {
      setPos(null);
      return;
    }
    const b = ref.current.getBoundingClientRect();
    let left = tip.x;
    let top = tip.y;
    if (tip.side === 'bottom' || tip.side === 'top') left -= b.width / 2;
    if (tip.side === 'top') top -= b.height;
    if (tip.side === 'left') left -= b.width;
    if (tip.side === 'left' || tip.side === 'right') top -= b.height / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - b.width - 6));
    if (top + b.height > window.innerHeight - 6) top = tip.y - b.height - 24;
    setPos({ left, top: Math.max(6, top) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" style={pos ?? { left: -9999, top: -9999 }} role="tooltip">
      {tip.text}
    </div>,
    document.body,
  );
}
