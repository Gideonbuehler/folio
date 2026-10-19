import { useEffect, useState } from 'react';
import { Check, Loader2, ScanText, X } from 'lucide-react';
import type { PageItem, SourceDoc } from '../types';
import { scrollToPage, useStore } from '../store';
import { cancelRecognition, dismissScanNotices, isScanned, recognizeText, useOcr } from '../lib/ocr';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** A quiet notice on scanned pages whose text hasn't been recognized yet. */
export function ScanNotice({ page, doc, recognized }: { page: PageItem; doc: SourceDoc | undefined; recognized: boolean }) {
  const [scan, setScan] = useState(false);
  const job = useOcr((s) => s.job);
  const dismissed = useOcr((s) => !!doc && s.dismissed.includes(doc.id));
  useEffect(() => {
    if (!doc || recognized) return;
    let alive = true;
    isScanned(doc, page).then((v) => alive && setScan(v));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page.src, page.index, recognized]);
  if (!doc || recognized || !scan) return null;

  const at = job?.phase === 'recognizing' ? job.pages.indexOf(page.id) : -1;
  if (job && at >= 0) {
    const state = at < job.done ? 'done' : at === job.done ? 'now' : 'waiting';
    return (
      <div className="scan-notice" onPointerDown={stop} onDoubleClick={stop} role="status">
        {state === 'done' ? <Check size={15} /> : <Loader2 size={15} className={state === 'now' ? 'spin' : ''} />}
        <span>{state === 'done' ? 'Text recognized' : state === 'now' ? `Recognizing text… ${Math.round(job.progress * 100)}%` : 'Waiting to recognize text…'}</span>
      </div>
    );
  }
  if (job || dismissed) return null;
  return (
    <div className="scan-notice" onPointerDown={stop} onDoubleClick={stop}>
      <ScanText size={15} />
      <span>Scanned page</span>
      <button type="button" className="scan-notice-action" onClick={() => void recognizeText([page.id])}>
        Recognize text
      </button>
      <button type="button" className="icon-btn sm" aria-label="Hide" data-tip="Hide for this document" onClick={() => dismissScanNotices(doc.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Progress of a running recognition, with a way to stop it. */
export function OcrProgress() {
  const job = useOcr((s) => s.job);
  const pages = useStore((s) => s.pages);
  if (!job) return null;
  const total = job.pages.length;
  const current = Math.min(job.done, total - 1);
  const overall = total ? (job.done + (job.phase === 'recognizing' ? job.progress : 0)) / total : 0;
  const pageNo = pages.findIndex((p) => p.id === job.pages[current]);
  const detail =
    job.phase === 'checking'
      ? 'Looking for scanned pages…'
      : job.phase === 'starting'
        ? 'Starting the text recognizer…'
        : total > 1
          ? `Page ${pageNo + 1} · ${current + 1} of ${total}`
          : `Page ${pageNo + 1}`;
  return (
    <div className="ocr-progress" role="status" aria-live="polite">
      <div className="ocr-progress-head">
        <Loader2 size={16} className="spin" />
        <strong>Recognizing text</strong>
        <button type="button" className="btn btn-ghost ocr-progress-cancel" onClick={cancelRecognition}>
          Cancel
        </button>
      </div>
      <div className="ocr-progress-detail">
        {job.phase === 'recognizing' && pageNo >= 0 ? (
          <button type="button" className="ocr-progress-page" onClick={() => scrollToPage(pageNo)}>
            {detail}
          </button>
        ) : (
          <span>{detail}</span>
        )}
        {job.phase === 'recognizing' && <span>{Math.round(job.progress * 100)}%</span>}
      </div>
      <div className="ocr-progress-bar">
        <div style={{ width: `${Math.round(overall * 1000) / 10}%` }} />
      </div>
    </div>
  );
}
