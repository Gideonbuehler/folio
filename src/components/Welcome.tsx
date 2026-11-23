import { useEffect } from 'react';
import { FilePlus2, Files, FileText, FolderOpen, ShieldCheck, X } from 'lucide-react';
import { combinePdfs, newBlankDocument, openPdf, openRecent } from '../lib/commands';
import { clearRecent, loadRecent, removeRecent, useRecent, visibleRecent } from '../lib/recent';
import { MOD } from '../lib/util';
import { IconButton } from './ui';
import { OutForSignature } from './RequestPanel';
import { BrandMark } from './BrandMark';

export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden>
          <BrandMark size={72} />
        </div>
        <h1>Edit PDFs without the clutter</h1>
        <p className="lede">Open a document to annotate, edit, sign, organize and protect it. Everything runs on your device; your files are never uploaded.</p>
        <div className="welcome-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={openPdf}>
            <FolderOpen size={18} /> Open PDF
          </button>
          <button type="button" className="btn btn-lg" onClick={combinePdfs}>
            <Files size={18} /> Combine files
          </button>
          <button type="button" className="btn btn-lg" onClick={newBlankDocument}>
            <FilePlus2 size={18} /> Blank document
          </button>
        </div>
        <p className="drop-hint">
          or drop a PDF anywhere · <kbd>{MOD}+O</kbd>
        </p>
        <OutForSignature />
        <RecentFiles />
      </div>
      <p className="privacy">
        <ShieldCheck size={14} /> Private by design: no accounts, no uploads.
      </p>
    </div>
  );
}

function ago(t: number) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const d = new Date(t);
  if (new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function RecentFiles() {
  const items = visibleRecent(useRecent((s) => s.items));
  useEffect(() => {
    void loadRecent();
  }, []);
  if (!items.length) return null;
  return (
    <section className="recent" aria-label="Recent files">
      <div className="recent-head">
        <h2>Recent</h2>
        <button type="button" className="btn btn-ghost" onClick={() => void clearRecent()}>
          Clear
        </button>
      </div>
      <ul className="recent-list">
        {items.map((it) => (
          <li key={it.id} className="recent-item">
            <button type="button" className="recent-open" onClick={() => void openRecent(it)} data-tip={it.path}>
              <FileText size={18} />
              <span className="recent-text">
                <span className="recent-name">{it.name}</span>
                {it.path && <span className="recent-path">{it.path.slice(0, Math.max(0, it.path.length - it.name.length - 1))}</span>}
              </span>
              <span className="recent-when">{ago(it.openedAt)}</span>
            </button>
            <IconButton tip="Remove from list" className="sm recent-remove" onClick={() => void removeRecent(it.id)}>
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
