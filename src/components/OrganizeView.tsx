import { useState } from 'react';
import { ArrowLeft, CopyPlus, FileOutput, FilePlus2, Files, RotateCcw, RotateCw, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { actions, deletePages, duplicatePages, insertBlankPage, rotatePages, scrollToPage, useStore } from '../store';
import { extractPages, insertPdfPages } from '../lib/commands';
import { Button, IconButton } from './ui';
import { Thumb } from './Thumb';
import { usePageGrid, useObjectsByPage } from './Sidebar';
import type { Obj } from '../types';

const NONE: Obj[] = [];
const SIZES = [120, 160, 220, 300];

export function OrganizeView() {
  const pages = useStore((s) => s.pages);
  const selection = useStore((s) => s.pageSelection);
  const byPage = useObjectsByPage();
  const grid = usePageGrid('x');
  const [size, setSize] = useState(1);
  const width = SIZES[size];
  const sel = selection.length ? selection : [];
  const lastSelected = Math.max(-1, ...sel.map((id) => pages.findIndex((p) => p.id === id)));
  const insertAt = lastSelected >= 0 ? lastSelected + 1 : pages.length;

  return (
    <div className="organize">
      <div className="organize-bar">
        <Button variant="ghost" onClick={() => actions.set({ organize: false })}>
          <ArrowLeft size={16} /> Back to document
        </Button>
        <span className="organize-count">
          {sel.length ? `${sel.length} of ${pages.length} selected` : `${pages.length} page${pages.length === 1 ? '' : 's'}`}
        </span>
        <div className="organize-actions">
          <IconButton tip="Rotate counterclockwise" disabled={!sel.length} onClick={() => rotatePages(sel, -90)}>
            <RotateCcw size={17} />
          </IconButton>
          <IconButton tip="Rotate clockwise" disabled={!sel.length} onClick={() => rotatePages(sel, 90)}>
            <RotateCw size={17} />
          </IconButton>
          <IconButton tip="Duplicate" disabled={!sel.length} onClick={() => duplicatePages(sel)}>
            <Files size={17} />
          </IconButton>
          <IconButton tip="Delete" disabled={!sel.length} onClick={() => deletePages(sel)}>
            <Trash2 size={17} />
          </IconButton>
          <span className="toolbar-sep" />
          <IconButton tip="Insert blank page" onClick={() => insertBlankPage(insertAt)}>
            <CopyPlus size={17} />
          </IconButton>
          <IconButton tip="Insert pages from file" onClick={() => insertPdfPages(insertAt)}>
            <FilePlus2 size={17} />
          </IconButton>
          <IconButton tip="Extract selected pages" disabled={!sel.length} onClick={() => extractPages(sel)}>
            <FileOutput size={17} />
          </IconButton>
          <span className="toolbar-sep" />
          <IconButton tip="Smaller" disabled={size === 0} onClick={() => setSize(size - 1)}>
            <ZoomOut size={17} />
          </IconButton>
          <IconButton tip="Larger" disabled={size === SIZES.length - 1} onClick={() => setSize(size + 1)}>
            <ZoomIn size={17} />
          </IconButton>
        </div>
      </div>
      <div
        className="organize-grid"
        tabIndex={0}
        onClick={(e) => e.target === e.currentTarget && actions.set({ pageSelection: [] })}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
            e.stopPropagation();
            deletePages(sel);
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            e.stopPropagation();
            actions.set({ pageSelection: pages.map((p) => p.id) });
          }
        }}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width + 28}px, 1fr))` }}
      >
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={`org-item ${selection.includes(p.id) ? 'selected' : ''}`}
            onClick={(e) => grid.select(e, i, p.id)}
            onDoubleClick={() => {
              actions.set({ organize: false });
              setTimeout(() => scrollToPage(i), 0);
            }}
            {...grid.handlers(i, p.id)}
          >
            {grid.drop === i && <div className="drop-bar" />}
            {grid.drop === pages.length && i === pages.length - 1 && <div className="drop-bar after" />}
            <div className="org-thumb">
              <Thumb page={p} width={width} objects={byPage.get(p.id) ?? NONE} />
              <div className="org-hover">
                <button type="button" aria-label="Rotate" data-tip="Rotate" onClick={(e) => (e.stopPropagation(), rotatePages([p.id], 90))}>
                  <RotateCw size={15} />
                </button>
                <button type="button" aria-label="Delete" data-tip="Delete" onClick={(e) => (e.stopPropagation(), deletePages([p.id]))}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <span className="org-num">{i + 1}</span>
          </div>
        ))}
      </div>
      {grid.menuEl}
    </div>
  );
}
