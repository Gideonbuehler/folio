import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Files,
  LayoutGrid,
  MessagesSquare,
  Plus,
  Search,
  CaseSensitive,
  X,
  MessageSquareText,
} from 'lucide-react';
import type { Obj, PageItem } from '../types';
import {
  actions,
  clearSearch,
  deletePages,
  gotoHit,
  insertBlankPage,
  movePages,
  runSearch,
  scrollToPage,
  updateObjects,
  useStore,
  type SidebarTab,
} from '../store';
import { applyMatrix, objBounds } from '../lib/geometry';
import { measureText } from '../lib/fonts';
import { ContextMenu, IconButton } from './ui';
import { Thumb } from './Thumb';
import { openExternal } from '../lib/native';
import { pageMenuItems } from './pageMenu';
import { OBJ_LABEL } from './labels';

const { get, set } = actions;

const TABS: { id: SidebarTab; label: string; icon: ReactNode }[] = [
  { id: 'pages', label: 'Pages', icon: <Files size={19} /> },
  { id: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={19} /> },
  { id: 'comments', label: 'Comments', icon: <MessagesSquare size={19} /> },
  { id: 'search', label: 'Search', icon: <Search size={19} /> },
];

export function Sidebar() {
  const tab = useStore((s) => s.sidebar);
  const count = useStore((s) => s.objects.length);
  return (
    <div className="sidebar">
      <nav className="rail" aria-label="Panels">
        {TABS.map((t) => (
          <IconButton
            key={t.id}
            tip={t.label}
            tipSide="right"
            active={tab === t.id}
            onClick={() => set({ sidebar: tab === t.id ? null : t.id })}
            className="rail-btn"
          >
            {t.icon}
            {t.id === 'comments' && count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}
          </IconButton>
        ))}
      </nav>
      {tab && (
        <aside className="panel" aria-label={tab}>
          {tab === 'pages' && <PagesPanel />}
          {tab === 'bookmarks' && <BookmarksPanel />}
          {tab === 'comments' && <CommentsPanel />}
          {tab === 'search' && <SearchPanel />}
        </aside>
      )}
    </div>
  );
}

function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <h3>{title}</h3>
      <div className="panel-actions">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Click-to-select and drag-to-reorder for page grids. */
export function usePageGrid(axis: 'x' | 'y') {
  const [drop, setDrop] = useState<number | null>(null);
  const anchor = useRef(-1);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; ids: string[] } | null>(null);

  const select = (e: React.MouseEvent, i: number, id: string) => {
    const s = get();
    let sel = s.pageSelection;
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      sel = s.pages.slice(a, b + 1).map((p) => p.id);
    } else if (e.ctrlKey || e.metaKey) {
      sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      anchor.current = i;
    } else {
      sel = [id];
      anchor.current = i;
    }
    set({ pageSelection: sel });
    return sel;
  };

  const handlers = (i: number, id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      const sel = get().pageSelection;
      const ids = sel.includes(id) ? sel : [id];
      if (!sel.includes(id)) set({ pageSelection: [id] });
      e.dataTransfer.setData('application/x-folio-pages', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-folio-pages')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = e.currentTarget.getBoundingClientRect();
      const after = axis === 'y' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      setDrop(i + (after ? 1 : 0));
    },
    onDrop: (e: React.DragEvent) => {
      const data = e.dataTransfer.getData('application/x-folio-pages');
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      if (drop !== null) movePages(JSON.parse(data), drop);
      setDrop(null);
    },
    onDragEnd: () => setDrop(null),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      const sel = get().pageSelection;
      const ids = sel.includes(id) ? sel : [id];
      if (!sel.includes(id)) set({ pageSelection: [id] });
      setMenu({ at: { x: e.clientX, y: e.clientY }, ids });
    },
  });

  const menuEl = <ContextMenu at={menu?.at ?? null} items={menu ? pageMenuItems(menu.ids) : []} onClose={() => setMenu(null)} />;
  return { drop, select, handlers, menuEl };
}

export function useObjectsByPage() {
  const objects = useStore((s) => s.objects);
  return useMemo(() => {
    const m = new Map<string, Obj[]>();
    for (const o of objects) {
      const l = m.get(o.page);
      if (l) l.push(o);
      else m.set(o.page, [o]);
    }
    return m;
  }, [objects]);
}

const NONE: Obj[] = [];

function PagesPanel() {
  const pages = useStore((s) => s.pages);
  const current = useStore((s) => s.currentPage);
  const selection = useStore((s) => s.pageSelection);
  const byPage = useObjectsByPage();
  const grid = usePageGrid('y');
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current page's thumbnail in view while scrolling the document.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb-index="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <>
      <PanelHead title="Pages">
        <IconButton tip="Insert blank page" onClick={() => insertBlankPage(get().currentPage + 1)}>
          <Plus size={16} />
        </IconButton>
        <IconButton tip="Organize pages" onClick={() => set({ organize: true })}>
          <LayoutGrid size={16} />
        </IconButton>
      </PanelHead>
      <div
        ref={listRef}
        className="thumb-list"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
            e.stopPropagation();
            deletePages(selection);
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            const n = Math.max(0, Math.min(pages.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
            set({ pageSelection: [pages[n].id] });
            scrollToPage(n);
          }
        }}
      >
        {pages.map((p, i) => (
          <div
            key={p.id}
            data-thumb-index={i}
            className={`thumb ${current === i ? 'current' : ''} ${selection.includes(p.id) ? 'selected' : ''}`}
            onClick={(e) => {
              grid.select(e, i, p.id);
              if (!e.shiftKey && !e.ctrlKey && !e.metaKey) scrollToPage(i);
            }}
            {...grid.handlers(i, p.id)}
          >
            {grid.drop === i && <div className="drop-line" />}
            <Thumb page={p} width={150} objects={byPage.get(p.id) ?? NONE} />
            <span className="thumb-num">{i + 1}</span>
            {grid.drop === pages.length && i === pages.length - 1 && <div className="drop-line after" />}
          </div>
        ))}
      </div>
      {grid.menuEl}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Bookmarks                                                           */
/* ------------------------------------------------------------------ */

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
  bold?: boolean;
  italic?: boolean;
}

function BookmarksPanel() {
  const pages = useStore((s) => s.pages);
  const docs = useStore((s) => s.docs);
  const primary = pages[0] ? docs[pages[0].src] : undefined;
  const [outline, setOutline] = useState<OutlineNode[] | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setOutline(undefined);
    primary?.pdf
      .getOutline()
      .then((o) => alive && setOutline(o as OutlineNode[] | null))
      .catch(() => alive && setOutline(null));
    return () => {
      alive = false;
    };
  }, [primary]);

  const go = async (node: OutlineNode) => {
    if (!primary) return;
    if (node.url) {
      void openExternal(node.url);
      return;
    }
    const dest = typeof node.dest === 'string' ? await primary.pdf.getDestination(node.dest) : node.dest;
    if (!Array.isArray(dest)) return;
    const ref = dest[0];
    const index = typeof ref === 'number' ? ref : await primary.pdf.getPageIndex(ref as { num: number; gen: number });
    const i = get().pages.findIndex((p) => p.src === primary.id && p.index === index);
    if (i < 0) return;
    const page: PageItem = get().pages[i];
    let y: number | undefined;
    if ((dest[1] as { name?: string })?.name === 'XYZ' && typeof dest[3] === 'number' && page.rotation === 0) {
      y = Math.max(0, applyMatrix(page.m, (dest[2] as number) ?? 0, dest[3] as number).y - 12);
    }
    scrollToPage(i, y);
  };

  return (
    <>
      <PanelHead title="Bookmarks" />
      <div className="panel-body">
        {outline === undefined ? (
          <p className="empty">Loading…</p>
        ) : !outline?.length ? (
          <div className="empty-state">
            <Bookmark size={28} />
            <p>This document has no bookmarks.</p>
          </div>
        ) : (
          <ul className="tree">
            {outline.map((n, i) => (
              <OutlineItem key={i} node={n} go={go} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function OutlineItem({ node, go, depth }: { node: OutlineNode; go: (n: OutlineNode) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = node.items?.length > 0;
  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
        {kids ? (
          <button type="button" className="tree-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <button
          type="button"
          className="tree-label"
          style={{ fontWeight: node.bold ? 600 : undefined, fontStyle: node.italic ? 'italic' : undefined }}
          onClick={() => go(node)}
          title={node.title}
        >
          {node.title}
        </button>
      </div>
      {kids && open && (
        <ul>
          {node.items.map((c, i) => (
            <OutlineItem key={i} node={c} go={go} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

function CommentsPanel() {
  const pages = useStore((s) => s.pages);
  const objects = useStore((s) => s.objects);
  const selection = useStore((s) => s.selection);
  const [filter, setFilter] = useState<'all' | 'comments'>('all');
  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);

  const list = useMemo(() => {
    const isComment = (o: Obj) => o.type === 'note' || o.type === 'highlight' || o.type === 'underline' || o.type === 'strike' || !!o.comment;
    return objects
      .filter((o) => pageIndex.has(o.page) && (filter === 'all' || isComment(o)))
      .map((o) => ({ o, i: pageIndex.get(o.page)!, b: objBounds(o, measureText) }))
      .sort((a, b) => a.i - b.i || a.b.y - b.b.y || a.b.x - b.b.x);
  }, [objects, pageIndex, filter]);

  let lastPage = -1;
  return (
    <>
      <PanelHead title="Comments">
        <select className="select sm" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'comments')} aria-label="Filter">
          <option value="all">All edits</option>
          <option value="comments">Comments</option>
        </select>
      </PanelHead>
      <div className="panel-body comments">
        {!list.length && (
          <div className="empty-state">
            <MessageSquareText size={28} />
            <p>No {filter === 'all' ? 'edits' : 'comments'} yet.</p>
            <p className="muted">Select text to highlight it, or use the Sticky note tool to leave a comment.</p>
          </div>
        )}
        {list.map(({ o, i, b }) => {
          const head = i !== lastPage ? <div className="comment-page">Page {i + 1}</div> : null;
          lastPage = i;
          return (
            <div key={o.id}>
              {head}
              <CommentCard
                o={o}
                active={selection.includes(o.id)}
                onFocus={() => {
                  set({ selection: [o.id], editing: null });
                  const page = pages[i];
                  scrollToPage(i, page.rotation === 0 ? Math.max(0, b.y - 60) : undefined);
                }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function CommentCard({ o, active, onFocus }: { o: Obj; active: boolean; onFocus: () => void }) {
  const [text, setText] = useState(o.comment ?? '');
  useEffect(() => setText(o.comment ?? ''), [o.comment]);
  const color = 'color' in o ? o.color : 'stroke' in o && typeof o.stroke === 'string' ? o.stroke : 'var(--text-3)';
  const quote = o.type === 'text' ? o.text : 'text' in o ? o.text : undefined;
  return (
    <div className={`comment-card ${active ? 'active' : ''}`} onClick={onFocus}>
      <div className="comment-head">
        <span className="comment-dot" style={{ background: color }} />
        <strong>{OBJ_LABEL[o.type]}</strong>
        <span className="muted">
          {o.author || 'Me'} · {timeAgo(o.created)}
        </span>
      </div>
      {quote && <blockquote>{quote.length > 160 ? `${quote.slice(0, 160)}…` : quote}</blockquote>}
      <textarea
        className="comment-input"
        rows={text ? Math.min(6, text.split('\n').length + 1) : 1}
        placeholder="Add a comment…"
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (o.comment ?? '') && updateObjects([o.id], { comment: text })}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function SearchPanel() {
  const search = useStore((s) => s.search);
  const pages = useStore((s) => s.pages);
  const [q, setQ] = useState(search.query);
  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q === search.query) return;
    const t = setTimeout(() => (q.trim() ? runSearch(q) : clearSearch()), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    listRef.current?.querySelector('.search-result.active')?.scrollIntoView({ block: 'nearest' });
  }, [search.active]);

  const shown = search.hits.slice(0, 500);
  let lastPage = -1;
  return (
    <>
      <PanelHead title="Search" />
      <div className="search-box">
        <Search size={15} className="search-icon" />
        <input
          className="search-input"
          placeholder="Find in document"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              if (q !== search.query) runSearch(q);
              else gotoHit(search.active + (e.shiftKey ? -1 : 1));
            }
            if (e.key === 'Escape') {
              setQ('');
              clearSearch();
            }
          }}
        />
        {q && (
          <button
            type="button"
            className="icon-btn sm"
            aria-label="Clear"
            onClick={() => {
              setQ('');
              clearSearch();
            }}
          >
            <X size={14} />
          </button>
        )}
        <IconButton tip="Match case" active={search.matchCase} className="sm" onClick={() => runSearch(q, !search.matchCase)}>
          <CaseSensitive size={16} />
        </IconButton>
      </div>
      {search.query.trim() && (
        <div className="search-summary">
          <span>
            {search.running ? 'Searching… ' : ''}
            {search.hits.length ? `${search.active + 1} of ${search.hits.length}` : search.running ? '' : 'No results'}
          </span>
          <span className="spacer" />
          <IconButton tip="Previous" shortcut="Shift+Enter" className="sm" disabled={!search.hits.length} onClick={() => gotoHit(search.active - 1)}>
            <ChevronUp size={16} />
          </IconButton>
          <IconButton tip="Next" shortcut="Enter" className="sm" disabled={!search.hits.length} onClick={() => gotoHit(search.active + 1)}>
            <ChevronDown size={16} />
          </IconButton>
        </div>
      )}
      <div ref={listRef} className="panel-body search-results">
        {shown.map((h, i) => {
          const pi = pageIndex.get(h.page) ?? 0;
          const head = pi !== lastPage ? <div className="comment-page">Page {pi + 1}</div> : null;
          lastPage = pi;
          return (
            <div key={i}>
              {head}
              <button type="button" className={`search-result ${i === search.active ? 'active' : ''}`} onClick={() => gotoHit(i)}>
                {h.before.length >= 40 ? '…' : ''}
                {h.before}
                <mark>{h.match}</mark>
                {h.after}
              </button>
            </div>
          );
        })}
        {search.hits.length > shown.length && <p className="empty">Showing the first {shown.length} results.</p>}
      </div>
    </>
  );
}
