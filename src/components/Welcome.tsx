import { EyeOff, FilePlus2, Files, FolderOpen, Highlighter, LayoutGrid, Lock, PenLine, Signature, TextCursorInput, ShieldCheck } from 'lucide-react';
import { combinePdfs, newBlankDocument, openPdf } from '../lib/commands';
import { MOD } from '../lib/util';

const FEATURES = [
  { icon: <TextCursorInput size={18} />, title: 'Edit text', text: 'Click any line to rewrite it in place.' },
  { icon: <Highlighter size={18} />, title: 'Annotate', text: 'Highlight, underline, notes and comments.' },
  { icon: <PenLine size={18} />, title: 'Draw & shapes', text: 'Pen, arrows, boxes, text boxes and images.' },
  { icon: <Signature size={18} />, title: 'Fill & sign', text: 'Fill forms, then sign by drawing or typing.' },
  { icon: <LayoutGrid size={18} />, title: 'Organize', text: 'Reorder, rotate, insert, extract and merge pages.' },
  { icon: <EyeOff size={18} />, title: 'Redact', text: 'Permanently remove sensitive content.' },
  { icon: <Lock size={18} />, title: 'Protect', text: 'Encrypt with a password (AES-256).' },
  { icon: <Files size={18} />, title: 'Combine', text: 'Merge several PDFs into one document.' },
];

export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="44" height="44">
            <rect x="5" y="2" width="22" height="28" rx="5" fill="var(--accent)" />
            <path d="M11 10h10M11 15.5h10M11 21h6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
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
      </div>
      <div className="features">
        {FEATURES.map((f) => (
          <div key={f.title} className="feature">
            <span className="feature-icon">{f.icon}</span>
            <div>
              <strong>{f.title}</strong>
              <p>{f.text}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="privacy">
        <ShieldCheck size={14} /> Private by design: no accounts, no uploads.
      </p>
    </div>
  );
}
