import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { moveTab, switchTab, tabState, useStore } from '../store';
import { closeTabs, openPdf } from '../lib/commands';
import { isPathRef } from '../lib/files';
import { MOD } from '../lib/util';
import { ContextMenu, IconButton } from './ui';
import '../tabs.css';

/** One tab per open document: click to switch, drag to reorder, middle-click or × to close. */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  // The active tab's name and state live in the top-level fields; subscribe so it re-renders.
  useStore((s) => s.fileName);
  useStore((s) => s.dirty);
  useStore((s) => s.fileHandle);
  const strip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  useEffect(() => {
    strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  /* Vertical wheel scrolls the strip sideways when tabs overflow. */
  useEffect(() => {
    const el = strip.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.deltaY || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll; middle-click closes on release
    if (e.button !== 0 || (e.target as Element).closest('.tab-close')) return;
    switchTab(id);
    const startX = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 5) return;
      if (!moved) {
        moved = true;
        setDragging(id);
      }
      // The tab goes after every other tab whose middle is left of the pointer.
      const others = [...strip.current!.querySelectorAll<HTMLElement>('.tab')].filter((el) => el.dataset.tab !== id);
      const to = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 < ev.clientX;
      }).length;
      moveTab(id, to);
    };
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const menuItems = (id: string) => {
    const ids = useStore.getState().tabs.map((t) => t.id);
    const i = ids.indexOf(id);
    return [
      { label: 'Close', shortcut: `${MOD}+W`, onClick: () => void closeTabs([id]) },
      { label: 'Close others', disabled: ids.length < 2, onClick: () => void closeTabs(ids.filter((x) => x !== id)) },
      { label: 'Close tabs to the right', disabled: i === ids.length - 1, onClick: () => void closeTabs(ids.slice(i + 1)) },
      { separator: true },
      { label: 'Close all', onClick: () => void closeTabs(ids) },
    ];
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Open documents">
      <div ref={strip} className="tab-strip">
        {tabs.map((t) => {
          const d = tabState(t.id);
          if (!d) return null;
          const on = t.id === active;
          return (
            <div
              key={t.id}
              data-tab={t.id}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={`tab ${on ? 'active' : ''} ${d.dirty ? 'dirty' : ''} ${dragging === t.id ? 'dragging' : ''}`}
              data-tip={dragging ? undefined : isPathRef(d.fileHandle) ? d.fileHandle.path : d.fileName}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTabs([t.id]);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: t.id });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  const ids = tabs.map((x) => x.id);
                  const next = ids[(ids.indexOf(t.id) + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
                  switchTab(next);
                  setTimeout(() => strip.current?.querySelector<HTMLElement>('.tab.active')?.focus(), 0);
                }
              }}
            >
              <FileText size={14} className="tab-icon" />
              <span className="tab-name">{d.fileName}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${d.fileName}`}
                data-tip={d.dirty ? 'Unsaved changes · Close' : 'Close'}
                onClick={() => void closeTabs([t.id])}
              >
                <span className="dirty-dot" />
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton tip="Open PDF" shortcut={`${MOD}+O`} className="sm tab-new" onClick={() => void openPdf()}>
        <Plus size={16} />
      </IconButton>
      <ContextMenu at={menu} items={menu ? menuItems(menu.id) : []} onClose={() => setMenu(null)} />
    </div>
  );
}
