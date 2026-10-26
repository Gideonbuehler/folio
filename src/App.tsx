import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FilePlus2, FolderOpen, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { Obj, Tool } from './types';
import {
  actions,
  addObject,
  copyObjects,
  deleteObjects,
  duplicateObjects,
  insertDocuments,
  openDocuments,
  pasteObjects,
  redo,
  scrollToPage,
  setTool,
  toast,
  undo,
  updateObjects,
  useStore,
  zoomStep,
} from './store';
import { moveObj } from './lib/geometry';
import { confirmDiscard, openPaths, openPdf, pickAndInsertImage, printDocument, saveDocument } from './lib/commands';
import { guardClose, isDesktop, onOpenFiles, setWindowTitle, startupFiles } from './lib/native';
import { insertImageFile } from './lib/images';
import { uid } from './lib/util';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Viewer, setZoomAnchor } from './components/Viewer';
import { OrganizeView } from './components/OrganizeView';
import { Welcome } from './components/Welcome';
import { DialogHost } from './components/Dialogs';
import { TooltipLayer } from './components/Tooltip';
import { OcrProgress } from './components/Ocr';
import { CompareView } from './components/CompareView';
import { SignatureBar } from './components/CertSign';
import { useCompare } from './lib/compare';

const { get, set } = actions;

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  e: 'editText',
  t: 'text',
  u: 'highlight',
  n: 'note',
  d: 'ink',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  w: 'whiteout',
  x: 'redact',
  f: 'fieldText',
};

export function App() {
  const hasDoc = useStore((s) => s.pages.length > 0);
  const organize = useStore((s) => s.organize);
  const comparing = useCompare((s) => s.open);
  useTheme();
  useShortcuts();
  useClipboard();
  useUnloadGuard();
  useOpenFromUrl();
  useDesktop();

  return (
    <div className="app">
      <Header />
      {hasDoc && !organize && !comparing && <Toolbar />}
      <main className="main">{hasDoc ? comparing ? <CompareView /> : organize ? <OrganizeView /> : <><Sidebar /><Viewer /><SignatureBar /></> : <Welcome />}</main>
      <DialogHost />
      <Toasts />
      <OcrProgress />
      <Busy />
      <DropOverlay />
      <TooltipLayer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function useTheme() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

/** Desktop app: files from Explorer, the close prompt and the window title. */
function useDesktop() {
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  useEffect(() => {
    if (!isDesktop) return;
    let stopFiles: (() => void) | undefined;
    let stopClose: (() => void) | undefined;
    startupFiles()
      .then((paths) => openPaths(paths))
      .catch(() => {});
    onOpenFiles((paths) => void openPaths(paths)).then((u) => (stopFiles = u));
    guardClose(() => get().dirty).then((u) => (stopClose = u));
    return () => {
      stopFiles?.();
      stopClose?.();
    };
  }, []);
  useEffect(() => {
    const title = fileName ? `${dirty ? '• ' : ''}${fileName} — Folio` : 'Folio';
    document.title = title;
    if (isDesktop) void setWindowTitle(title).catch(() => {});
  }, [fileName, dirty]);
}

function useUnloadGuard() {
  useEffect(() => {
    if (isDesktop) return; // the window close prompt covers this in the app
    const h = (e: BeforeUnloadEvent) => {
      if (get().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);
}

/** `?file=/path/to.pdf` opens a same-origin PDF on load. */
function useOpenFromUrl() {
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('file');
    if (!url) return;
    let resolved: URL;
    try {
      resolved = new URL(url, location.href);
    } catch {
      return;
    }
    if (resolved.origin !== location.origin) {
      toast('Only files from this site can be opened by link', 'error');
      return;
    }
    fetch(resolved)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => openDocuments([{ file: new File([b], decodeURIComponent(resolved.pathname.split('/').pop() || 'Document.pdf'), { type: 'application/pdf' }), handle: null }]))
      .catch((e) => toast(`Couldn't open ${url}: ${e.message}`, 'error'));
  }, []);
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
}

function useShortcuts() {
  const spaceTool = useRef<Tool | null>(null);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = get();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const hasDoc = s.pages.length > 0;
      if (s.dialog || s.busy) return;

      if (mod) {
        const handled = (() => {
          switch (key) {
            case 'o':
              void openPdf();
              return true;
            case 's':
              if (hasDoc) void saveDocument({ saveAs: e.shiftKey });
              return true;
            case 'p':
              if (hasDoc) void printDocument();
              return true;
            case 'f':
              if (!hasDoc) return false;
              set({ sidebar: 'search', organize: false });
              setTimeout(() => {
                const input = document.querySelector<HTMLInputElement>('.search-input');
                input?.focus();
                input?.select();
              }, 0);
              return true;
          }
          if (isTyping(e.target) || !hasDoc) return false;
          switch (key) {
            case 'z':
              if (e.shiftKey) redo();
              else undo();
              return true;
            case 'y':
              redo();
              return true;
            case '=':
            case '+':
              zoomAtCenter(1);
              return true;
            case '-':
              zoomAtCenter(-1);
              return true;
            case '0':
              set({ zoom: 1, fit: null });
              return true;
            case '1':
              set({ fit: 'width' });
              return true;
            case '2':
              set({ fit: 'page' });
              return true;
            case 'd':
              if (s.selection.length) duplicateObjects(s.selection);
              return true;
            case 'c':
              if (s.selection.length && !window.getSelection()?.toString()) {
                const n = copyObjects(s.selection);
                toast(`Copied ${n} item${n === 1 ? '' : 's'}`);
                return true;
              }
              return false;
            case 'b':
            case 'i': {
              const texts = s.objects.filter((o) => s.selection.includes(o.id) && o.type === 'text');
              if (!texts.length) return false;
              const prop = key === 'b' ? 'bold' : 'italic';
              const on = !texts.every((o) => (o as Extract<Obj, { type: 'text' }>)[prop]);
              updateObjects(texts.map((o) => o.id), { [prop]: on } as Partial<Obj>);
              return true;
            }
            case 'a':
              if (s.organize) return false;
              {
                const page = s.pages[s.currentPage];
                const ids = s.objects.filter((o) => o.page === page?.id).map((o) => o.id);
                if (!ids.length) return false;
                set({ selection: ids, editing: null });
              }
              return true;
          }
          return false;
        })();
        if (handled) e.preventDefault();
        return;
      }

      if (isTyping(e.target) || !hasDoc) return;

      if (e.key === ' ' && !e.repeat && s.tool !== 'hand' && !s.organize) {
        spaceTool.current = s.tool;
        set({ tool: 'hand' });
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (s.openNote) set({ openNote: null });
        else if (s.selection.length) set({ selection: [] });
        else if (s.organize) set({ organize: false });
        else if (s.tool !== 'select') setTool('select');
        window.getSelection()?.removeAllRanges();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) {
        e.preventDefault();
        deleteObjects(s.selection);
        return;
      }
      if (e.key.startsWith('Arrow') && s.selection.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        updateObjects(s.selection, (o) => moveObj(o, dx, dy));
        return;
      }
      if (s.organize) return;
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        scrollToPage(s.currentPage + (e.key === 'PageDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Home' && !s.selection.length) return scrollToPage(0);
      if (e.key === 'End' && !s.selection.length) return scrollToPage(s.pages.length - 1);
      if (e.key === '?') {
        set({ dialog: { kind: 'shortcuts' } });
        return;
      }
      if (e.altKey) return;
      if (key === 'i') {
        void pickAndInsertImage();
        return;
      }
      if (key === 's') {
        set({ dialog: { kind: 'signature' } });
        return;
      }
      const tool = TOOL_KEYS[key];
      if (tool) setTool(tool);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceTool.current) {
        set({ tool: spaceTool.current });
        spaceTool.current = null;
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}

function zoomAtCenter(dir: 1 | -1) {
  const v = document.querySelector('.viewer');
  if (v) {
    const r = v.getBoundingClientRect();
    setZoomAnchor(r.left + r.width / 2, r.top + r.height / 2);
  }
  zoomStep(dir);
}

/** Paste images, copied objects, or plain text onto the current page. */
function useClipboard() {
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const s = get();
      if (isTyping(e.target) || !s.pages.length || s.dialog) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        files.forEach((f) => insertImageFile(f));
        return;
      }
      if (pasteObjects()) {
        e.preventDefault();
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim();
      const page = s.pages[s.currentPage];
      if (text && page) {
        e.preventDefault();
        const st = s.style;
        const o: Obj = {
          id: uid(),
          page: page.id,
          created: Date.now(),
          author: s.userName,
          opacity: 1,
          type: 'text',
          x: 72,
          y: 72,
          text: text.slice(0, 5000),
          font: st.font,
          size: st.size,
          bold: st.bold,
          italic: st.italic,
          color: st.textColor,
        };
        addObject(o);
      }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);
}

/* ------------------------------------------------------------------ */

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'error' ? <TriangleAlert size={16} /> : t.kind === 'success' ? <CheckCircle2 size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Busy() {
  const busy = useStore((s) => s.busy);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShow(false);
      return;
    }
    // Avoid flashing the overlay for quick operations.
    const t = setTimeout(() => setShow(true), 180);
    return () => clearTimeout(t);
  }, [busy]);
  if (!busy || !show) return busy ? <div className="busy-shield" /> : null;
  return (
    <div className="busy">
      <div className="busy-card">
        <Loader2 size={20} className="spin" />
        <span>{busy}</span>
      </div>
    </div>
  );
}

function DropOverlay() {
  const hasDoc = useStore((s) => s.pages.length > 0);
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const isPdfDrag = (e: DragEvent) => [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file' && (i.type === 'application/pdf' || i.type === ''));
    const enter = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      depth.current++;
      setActive(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (isPdfDrag(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!isPdfDrag(e)) return;
      e.preventDefault();
      if (!get().pages.length) void handleFiles(e, 'open');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!active) return null;
  const zone = (mode: 'open' | 'insert', icon: React.ReactNode, title: string, text: string) => (
    <div
      className="drop-zone"
      onDragOver={(e) => {
        e.preventDefault();
        e.currentTarget.classList.add('hot');
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove('hot')}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setActive(false);
        void handleFiles(e.nativeEvent, mode);
      }}
    >
      {icon}
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
  return (
    <div className="drop-overlay">
      {zone('open', <FolderOpen size={28} />, hasDoc ? 'Open' : 'Drop to open', hasDoc ? 'Replace the current document' : 'Several files are combined into one')}
      {hasDoc && zone('insert', <FilePlus2 size={28} />, 'Insert pages', `Add after page ${get().currentPage + 1}`)}
    </div>
  );
}

async function handleFiles(e: DragEvent, mode: 'open' | 'insert') {
  const files = [...(e.dataTransfer?.files ?? [])];
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length && get().pages.length) images.forEach((f) => insertImageFile(f));
  if (!pdfs.length) return;
  const picked = pdfs.map((file) => ({ file, handle: null }));
  if (mode === 'insert') await insertDocuments(picked, get().currentPage + 1);
  else {
    if (!(await confirmDiscard())) return;
    await openDocuments(picked);
  }
}
