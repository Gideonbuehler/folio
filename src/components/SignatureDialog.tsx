import { useEffect, useRef, useState } from 'react';
import { Calendar, Check, Trash2, Upload, X as XIcon } from 'lucide-react';
import type { InkObj, StampTarget, TextObj } from '../types';
import { actions, addObject, savePref, toast } from '../store';
import { initialsOf, signerById } from '../lib/envelope';
import { stampField } from '../lib/signing';
import { placeImage, normalizeImage } from '../lib/images';
import { loadImage, uid } from '../lib/util';
import { Button, Modal, Segmented, Toggle } from './ui';

const SCRIPT_FONTS = [
  { label: 'Classic', css: '"Segoe Script", "Brush Script MT", cursive' },
  { label: 'Flowing', css: '"Brush Script MT", "Segoe Script", cursive' },
  { label: 'Hand', css: '"Ink Free", "Segoe Print", "Bradley Hand", cursive' },
  { label: 'Formal', css: '"Lucida Handwriting", "Apple Chancery", cursive' },
];

const INKS = ['#1a1a1a', '#1c3faa', '#c92a2a'];

/** Signatures saved in Fill & sign, newest first. */
export function savedSignatures(): string[] {
  return loadSaved('signatures');
}

function loadSaved(key: 'signatures' | 'initials'): string[] {
  try {
    return JSON.parse(localStorage.getItem(`folio.${key}`) || '[]');
  } catch {
    return [];
  }
}

/** Crops a canvas to its painted pixels. */
function trimCanvas(src: HTMLCanvasElement, pad = 8): HTMLCanvasElement | null {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width,
    y1 = height,
    x2 = -1,
    y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1 + pad * 2;
  out.height = y2 - y1 + 1 + pad * 2;
  out.getContext('2d')!.drawImage(src, x1, y1, x2 - x1 + 1, y2 - y1 + 1, pad, pad, x2 - x1 + 1, y2 - y1 + 1);
  return out;
}

/** Fill & sign; with a target, signing a signature request's field. */
export function SignatureDialog({ target }: { target?: StampTarget }) {
  const close = () => actions.set({ dialog: null });
  const env = actions.get().envelope;
  const signerName = (target && env && signerById(env, target.signer)?.name) || '';
  const key = target?.initials ? 'initials' : 'signatures';
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [ink, setInk] = useState(INKS[0]);
  const [name, setName] = useState(target?.initials ? initialsOf(signerName) : signerName);
  const [font, setFont] = useState(0);
  const [upload, setUpload] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState<string[]>(() => loadSaved(key));
  const [hasInk, setHasInk] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (mode !== 'draw') return;
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    setHasInk(false);
  }, [mode]);

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6 * sx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let last = { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sx };
    let mid = last;
    ctx.beginPath();
    ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    c.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sx };
      const m = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(mid.x, mid.y);
      ctx.quadraticCurveTo(last.x, last.y, m.x, m.y);
      ctx.stroke();
      last = p;
      mid = m;
    };
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      setHasInk(true);
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  };

  const build = async (): Promise<HTMLCanvasElement | null> => {
    if (mode === 'draw') return canvas.current && hasInk ? trimCanvas(canvas.current) : null;
    if (mode === 'type') {
      if (!name.trim()) return null;
      const c = document.createElement('canvas');
      c.width = 1400;
      c.height = 300;
      const ctx = c.getContext('2d')!;
      ctx.font = `120px ${SCRIPT_FONTS[font].css}`;
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(name.trim(), 30, 150, 1340);
      return trimCanvas(c, 12);
    }
    if (!upload) return null;
    const img = await loadImage(upload);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    // Scanned signatures: make the paper transparent.
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
      if (lum > 225) d.data[i + 3] = 0;
      else if (lum > 180) d.data[i + 3] = Math.min(d.data[i + 3], ((225 - lum) / 45) * 255);
    }
    ctx.putImageData(d, 0, 0);
    return trimCanvas(c, 4);
  };

  const place = (src: string, w: number, h: number) => {
    if (target) stampField(target, src, w, h);
    else placeImage(src, w, h, { signature: true });
    close();
  };

  const create = async () => {
    const c = await build();
    if (!c) {
      toast(mode === 'draw' ? 'Draw your signature first' : mode === 'type' ? 'Type your name first' : 'Choose an image first', 'error');
      return;
    }
    const src = c.toDataURL('image/png');
    if (remember) {
      const next = [src, ...saved.filter((s) => s !== src)].slice(0, 6);
      savePref(key, next);
    }
    place(src, c.width, c.height);
  };

  const quickText = (text: string) => {
    const s = actions.get();
    const page = s.pages[s.currentPage];
    if (!page) return;
    const o: TextObj = {
      id: uid(),
      page: page.id,
      created: Date.now(),
      author: s.userName,
      opacity: 1,
      type: 'text',
      x: page.w / 2 - 40,
      y: page.h / 2 - 10,
      text,
      font: 'sans',
      size: 12,
      bold: false,
      italic: false,
      color: '#1a1a1a',
    };
    addObject(o);
    actions.set({ tool: 'select' });
    close();
  };

  const quickMark = (kind: 'check' | 'cross') => {
    const s = actions.get();
    const page = s.pages[s.currentPage];
    if (!page) return;
    const cx = page.w / 2;
    const cy = page.h / 2;
    const strokes =
      kind === 'check'
        ? [[cx - 7, cy, cx - 2, cy + 6, cx + 8, cy - 7]]
        : [
            [cx - 6, cy - 6, cx + 6, cy + 6],
            [cx + 6, cy - 6, cx - 6, cy + 6],
          ];
    const o: InkObj = { id: uid(), page: page.id, created: Date.now(), author: s.userName, opacity: 1, type: 'ink', strokes, stroke: '#1a1a1a', width: 2 };
    addObject(o);
    actions.set({ tool: 'select' });
    close();
  };

  return (
    <Modal
      title={target ? (target.initials ? 'Add your initials' : `Sign as ${signerName}`) : 'Fill & sign'}
      onClose={close}
      width={560}
      footer={
        <>
          {!target && (
            <div className="quick-marks">
              <Button variant="ghost" onClick={() => quickText(new Date().toLocaleDateString())}>
                <Calendar size={15} /> Date
              </Button>
              <Button variant="ghost" onClick={() => quickMark('check')}>
                <Check size={15} /> Check
              </Button>
              <Button variant="ghost" onClick={() => quickMark('cross')}>
                <XIcon size={15} /> Cross
              </Button>
            </div>
          )}
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={create}>
            {target ? (target.initials ? 'Add initials' : 'Sign') : 'Place signature'}
          </Button>
        </>
      }
    >
      {saved.length > 0 && (
        <div className="saved-sigs">
          <span className="field-label">{target?.initials ? 'Saved initials' : 'Saved signatures'}</span>
          <div className="saved-sig-row">
            {saved.map((s) => (
              <div key={s} className="saved-sig">
                <button
                  type="button"
                  onClick={async () => {
                    const img = await loadImage(s);
                    place(s, img.naturalWidth, img.naturalHeight);
                  }}
                  aria-label="Use this signature"
                >
                  <img src={s} alt="Saved signature" />
                </button>
                <button
                  type="button"
                  className="saved-sig-del"
                  aria-label="Remove"
                  onClick={() => {
                    const next = saved.filter((x) => x !== s);
                    setSaved(next);
                    savePref(key, next);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="sig-tabs">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'draw', label: 'Draw' },
            { value: 'type', label: 'Type' },
            { value: 'upload', label: 'Upload' },
          ]}
        />
        {mode !== 'upload' && (
          <div className="ink-picker">
            {INKS.map((c) => (
              <button key={c} type="button" className={`ink-dot ${ink === c ? 'sel' : ''}`} style={{ background: c }} onClick={() => setInk(c)} aria-label={`Ink ${c}`} />
            ))}
          </div>
        )}
      </div>

      {mode === 'draw' && (
        <div className="sig-pad">
          <canvas ref={canvas} onPointerDown={draw} />
          <div className="sig-line" />
          {!hasInk && <span className="sig-hint">Sign here</span>}
          {hasInk && (
            <button
              type="button"
              className="sig-clear"
              onClick={() => {
                const c = canvas.current!;
                c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
                setHasInk(false);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {mode === 'type' && (
        <div className="sig-type">
          <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <div className="sig-fonts">
            {SCRIPT_FONTS.map((f, i) => (
              <button key={f.label} type="button" className={`sig-font ${font === i ? 'sel' : ''}`} onClick={() => setFont(i)} style={{ fontFamily: f.css, color: ink }}>
                {name.trim() || 'Your Name'}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'upload' && (
        <label className="sig-upload">
          {upload ? <img src={upload} alt="Uploaded signature" /> : (
            <>
              <Upload size={22} />
              <span>Choose an image of your signature</span>
              <span className="muted">White backgrounds are removed automatically</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setUpload((await normalizeImage(f)).src);
            }}
          />
        </label>
      )}

      <Toggle checked={remember} onChange={setRemember} label="Save this signature for next time" />
    </Modal>
  );
}
