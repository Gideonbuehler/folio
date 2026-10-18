import {
  BookOpen,
  Download,
  FileImage,
  FileOutput,
  FilePlus2,
  Files,
  FolderOpen,
  Hash,
  Info,
  Keyboard,
  LayoutGrid,
  Lock,
  Minus,
  Monitor,
  Moon,
  Plus,
  Printer,
  Redo2,
  Save,
  Search,
  Signature,
  Stamp,
  Sun,
  Undo2,
  X,
  ChevronDown,
  CopyPlus,
} from 'lucide-react';
import { actions, insertBlankPage, redo, setTheme, setZoom, undo, useStore, zoomStep, ZOOM_STEPS } from '../store';
import { closeDoc, combinePdfs, extractPages, insertPdfPages, newBlankDocument, openPdf, printDocument, saveDocument } from '../lib/commands';
import { MOD } from '../lib/util';
import { canSaveInPlace } from '../lib/files';
import { IconButton, MenuButton, Popover, usePopover, type MenuItem } from './ui';
import { setZoomAnchor } from './Viewer';

const I = 16;

export function Header() {
  const hasDoc = useStore((s) => s.pages.length > 0);
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const set = actions.set;

  const fileItems = (): MenuItem[] => [
    { label: 'Open…', icon: <FolderOpen size={I} />, shortcut: `${MOD}+O`, onClick: openPdf },
    { label: 'Combine files…', icon: <Files size={I} />, onClick: combinePdfs },
    { label: 'New blank document', icon: <FilePlus2 size={I} />, onClick: newBlankDocument },
    { separator: true },
    { label: 'Save', icon: <Save size={I} />, shortcut: `${MOD}+S`, disabled: !hasDoc, onClick: () => saveDocument() },
    { label: 'Save as…', icon: <Download size={I} />, shortcut: `${MOD}+Shift+S`, disabled: !hasDoc, onClick: () => saveDocument({ saveAs: true }) },
    { label: 'Save with options…', icon: <Lock size={I} />, disabled: !hasDoc, onClick: () => set({ dialog: { kind: 'save', saveAs: true } }) },
    { separator: true },
    { label: 'Export pages as images…', icon: <FileImage size={I} />, disabled: !hasDoc, onClick: () => set({ dialog: { kind: 'exportImages' } }) },
    { label: 'Print…', icon: <Printer size={I} />, shortcut: `${MOD}+P`, disabled: !hasDoc, onClick: printDocument },
    { separator: true },
    { label: 'Document properties…', icon: <Info size={I} />, disabled: !hasDoc, onClick: () => set({ dialog: { kind: 'properties' } }) },
    { label: 'Close document', icon: <X size={I} />, disabled: !hasDoc, onClick: closeDoc },
  ];

  const toolItems = (): MenuItem[] => {
    const s = actions.get();
    return [
      { heading: 'Pages' },
      { label: 'Organize pages', icon: <LayoutGrid size={I} />, onClick: () => set({ organize: true }) },
      { label: 'Insert blank page', icon: <CopyPlus size={I} />, onClick: () => insertBlankPage(s.currentPage + 1) },
      { label: 'Insert pages from file…', icon: <FilePlus2 size={I} />, onClick: () => insertPdfPages() },
      {
        label: 'Extract current page…',
        icon: <FileOutput size={I} />,
        onClick: () => extractPages(s.pageSelection.length ? s.pageSelection : [s.pages[s.currentPage].id]),
      },
      { separator: true },
      { heading: 'Stamp & sign' },
      { label: 'Fill & sign…', icon: <Signature size={I} />, onClick: () => set({ dialog: { kind: 'signature' } }) },
      { label: 'Watermark…', icon: <Stamp size={I} />, onClick: () => set({ dialog: { kind: 'watermark' } }) },
      { label: 'Page numbers & header/footer…', icon: <Hash size={I} />, onClick: () => set({ dialog: { kind: 'pageNumbers' } }) },
      { separator: true },
      { label: 'Keyboard shortcuts', icon: <Keyboard size={I} />, shortcut: '?', onClick: () => set({ dialog: { kind: 'shortcuts' } }) },
    ];
  };

  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';

  return (
    <header className="header">
      <div className="header-left">
        <div className="brand" aria-label="Folio">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <rect x="5" y="2" width="22" height="28" rx="5" fill="var(--accent)" />
            <path d="M11 10h10M11 15.5h10M11 21h6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>Folio</span>
        </div>
        <MenuButton label="File" items={fileItems} className="ghost" />
        {hasDoc && <MenuButton label="Tools" items={toolItems} className="ghost" />}
      </div>

      <div className="header-center">
        {hasDoc && (
          <div className="doc-title" title={fileName}>
            <BookOpen size={15} />
            <span className="doc-name">{fileName}</span>
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes" data-tip="Unsaved changes" />}
          </div>
        )}
      </div>

      <div className="header-right">
        {hasDoc && (
          <>
            <IconButton tip="Undo" shortcut={`${MOD}+Z`} disabled={!canUndo} onClick={undo}>
              <Undo2 size={17} />
            </IconButton>
            <IconButton tip="Redo" shortcut={`${MOD}+Shift+Z`} disabled={!canRedo} onClick={redo}>
              <Redo2 size={17} />
            </IconButton>
            <span className="toolbar-sep" />
            <ZoomControl />
            <span className="toolbar-sep" />
            <IconButton
              tip="Search"
              shortcut={`${MOD}+F`}
              onClick={() => {
                set({ sidebar: 'search' });
                setTimeout(() => document.querySelector<HTMLInputElement>('.search-input')?.focus(), 0);
              }}
            >
              <Search size={17} />
            </IconButton>
          </>
        )}
        <IconButton tip={`Theme: ${theme}`} onClick={() => setTheme(nextTheme)}>
          {theme === 'dark' ? <Moon size={17} /> : theme === 'light' ? <Sun size={17} /> : <Monitor size={17} />}
        </IconButton>
        {hasDoc && (
          <button type="button" className="btn btn-primary save-btn" onClick={() => saveDocument()} data-tip={canSaveInPlace ? `Save  ·  ${MOD}+S` : `Download  ·  ${MOD}+S`}>
            <Save size={16} />
            <span>Save</span>
          </button>
        )}
      </div>
    </header>
  );
}

function ZoomControl() {
  const zoom = useStore((s) => s.zoom);
  const fit = useStore((s) => s.fit);
  const p = usePopover();
  const center = () => {
    const v = document.querySelector('.viewer');
    if (v) {
      const r = v.getBoundingClientRect();
      setZoomAnchor(r.left + r.width / 2, r.top + r.height / 2);
    }
  };
  return (
    <div className="zoom-control">
      <IconButton
        tip="Zoom out"
        shortcut={`${MOD}+−`}
        onClick={() => {
          center();
          zoomStep(-1);
        }}
      >
        <Minus size={16} />
      </IconButton>
      <button ref={p.anchor} type="button" className="zoom-value" onClick={p.toggle} data-tip={!p.open ? 'Zoom' : undefined}>
        {Math.round(zoom * 100)}%
        <ChevronDown size={12} className="caret" />
      </button>
      <IconButton
        tip="Zoom in"
        shortcut={`${MOD}++`}
        onClick={() => {
          center();
          zoomStep(1);
        }}
      >
        <Plus size={16} />
      </IconButton>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close} align="center">
        <div className="menu">
          <button type="button" className="menu-item" onClick={() => (actions.set({ fit: 'width' }), p.close())}>
            <span className="menu-icon">{fit === 'width' ? '✓' : ''}</span>
            <span className="menu-label">Fit width</span>
            <span className="menu-shortcut">{MOD}+1</span>
          </button>
          <button type="button" className="menu-item" onClick={() => (actions.set({ fit: 'page' }), p.close())}>
            <span className="menu-icon">{fit === 'page' ? '✓' : ''}</span>
            <span className="menu-label">Fit page</span>
            <span className="menu-shortcut">{MOD}+2</span>
          </button>
          <div className="menu-sep" />
          {ZOOM_STEPS.filter((z) => z >= 0.5 && z <= 4).map((z) => (
            <button
              key={z}
              type="button"
              className="menu-item"
              onClick={() => {
                center();
                setZoom(z);
                p.close();
              }}
            >
              <span className="menu-icon">{!fit && Math.abs(zoom - z) < 0.001 ? '✓' : ''}</span>
              <span className="menu-label">{Math.round(z * 100)}%</span>
              {z === 1 && <span className="menu-shortcut">{MOD}+0</span>}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
