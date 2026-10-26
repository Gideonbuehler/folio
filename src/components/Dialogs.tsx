import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { DocMeta, FontFamily, Obj, PageItem, TextObj } from '../types';
import { actions, commit, setMeta, setUserName, useStore } from '../store';
import { exportImages, saveDocument } from '../lib/commands';
import { settleGeometry } from '../lib/pdfjs';
import { FONT_LABEL, measureText } from '../lib/fonts';
import { baseName, formatBytes, MOD, uid } from '../lib/util';
import { Button, ColorButton, Field, Modal, Segmented, Slider, Toggle } from './ui';
import { SignatureDialog } from './SignatureDialog';

const close = () => actions.set({ dialog: null });

/** Page sizes are needed to place objects on every page; a large document may still be measuring some. */
const allMeasured = () => settleGeometry(actions.get().pages, actions.get().docs);

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'signature':
      return <SignatureDialog />;
    case 'watermark':
      return <WatermarkDialog />;
    case 'pageNumbers':
      return <PageNumbersDialog />;
    case 'properties':
      return <PropertiesDialog />;
    case 'save':
      return <SaveDialog />;
    case 'password':
      return <PasswordDialog name={dialog.name} retry={dialog.retry} resolve={dialog.resolve} />;
    case 'exportImages':
      return <ExportImagesDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
  }
}

/* ------------------------------------------------------------------ */
/* Page ranges                                                          */
/* ------------------------------------------------------------------ */

type Scope = 'all' | 'current' | 'range';

/** Parses "1-3, 5, 8-" into zero-based indices. */
function parseRange(text: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count) out.add(n - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function scopePages(scope: Scope, range: string): PageItem[] {
  const s = actions.get();
  if (scope === 'current') return [s.pages[s.currentPage]];
  if (scope === 'range') return parseRange(range, s.pages.length).map((i) => s.pages[i]);
  return s.pages;
}

function ScopePicker({ scope, setScope, range, setRange }: { scope: Scope; setScope: (s: Scope) => void; range: string; setRange: (r: string) => void }) {
  return (
    <Field label="Pages">
      <div className="row">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'current', label: 'Current' },
            { value: 'range', label: 'Range' },
          ]}
        />
        {scope === 'range' && <input className="input" placeholder="e.g. 1-3, 5" value={range} onChange={(e) => setRange(e.target.value)} />}
      </div>
    </Field>
  );
}

function textObj(page: PageItem, patch: Partial<TextObj>): TextObj {
  return {
    id: uid(),
    page: page.id,
    created: Date.now(),
    author: actions.get().userName,
    opacity: 1,
    type: 'text',
    x: 0,
    y: 0,
    text: '',
    font: 'sans',
    size: 12,
    bold: false,
    italic: false,
    color: '#1a1a1a',
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Watermark                                                            */
/* ------------------------------------------------------------------ */

function WatermarkDialog() {
  const [text, setText] = useState('CONFIDENTIAL');
  const [size, setSize] = useState(64);
  const [color, setColor] = useState('#868e96');
  const [opacity, setOpacity] = useState(0.3);
  const [angle, setAngle] = useState<'-45' | '0' | '45'>('-45');
  const [font, setFont] = useState<FontFamily>('sans');
  const [bold, setBold] = useState(true);
  const [scope, setScope] = useState<Scope>('all');
  const [range, setRange] = useState('');

  const apply = async () => {
    await allMeasured();
    const pages = scopePages(scope, range);
    if (!text.trim() || !pages.length) return;
    const objs: Obj[] = pages.map((p) => {
      const box = measureText({ text, font, size, bold, italic: false });
      return textObj(p, { text, font, size, bold, color, opacity, rotate: Number(angle), x: (p.w - box.w) / 2, y: (p.h - box.h) / 2 });
    });
    commit((s) => ({ objects: [...s.objects, ...objs] }));
    close();
  };

  return (
    <Modal
      title="Add watermark"
      onClose={close}
      footer={
        <>
          <span className="muted small">Watermarks stay editable until you save.</span>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Add watermark
          </Button>
        </>
      }
    >
      <div className="wm-preview">
        <span
          style={{
            fontFamily: font === 'sans' ? 'Arial' : font === 'serif' ? 'Times New Roman' : 'Courier New',
            fontWeight: bold ? 700 : 400,
            color,
            opacity,
            transform: `rotate(${angle}deg)`,
            fontSize: Math.min(34, size * 0.45),
          }}
        >
          {text || ' '}
        </span>
      </div>
      <Field label="Text">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
      <div className="row">
        <Field label="Font">
          <select className="select" value={font} onChange={(e) => setFont(e.target.value as FontFamily)}>
            {(Object.keys(FONT_LABEL) as FontFamily[]).map((f) => (
              <option key={f} value={f}>
                {FONT_LABEL[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Color">
          <ColorButton tip="Color" kind="text" value={color} onChange={(c) => c && setColor(c)} />
        </Field>
        <Field label="Angle">
          <Segmented
            value={angle}
            onChange={setAngle}
            options={[
              { value: '-45', label: '⟋' },
              { value: '0', label: '—' },
              { value: '45', label: '⟍' },
            ]}
          />
        </Field>
      </div>
      <Slider label="Size" value={size} min={12} max={160} onChange={setSize} format={(v) => `${v}pt`} />
      <Slider label="Opacity" value={Math.round(opacity * 100)} min={5} max={100} step={5} onChange={(v) => setOpacity(v / 100)} format={(v) => `${v}%`} />
      <Toggle checked={bold} onChange={setBold} label="Bold" />
      <ScopePicker scope={scope} setScope={setScope} range={range} setRange={setRange} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Page numbers, headers and footers                                     */
/* ------------------------------------------------------------------ */

const POSITIONS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'] as const;
type Pos = (typeof POSITIONS)[number];

const FORMATS = ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}', '- {n} -'];

function PageNumbersDialog() {
  const fileName = useStore((s) => s.fileName);
  const [pos, setPos] = useState<Pos>('bc');
  const [format, setFormat] = useState('Page {n} of {total}');
  const [start, setStart] = useState(1);
  const [size, setSize] = useState(10);
  const [margin, setMargin] = useState(30);
  const [color, setColor] = useState('#495057');
  const [skipFirst, setSkipFirst] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [range, setRange] = useState('');

  const render = (n: number, total: number) =>
    format
      .replace(/\{n\}/g, String(n))
      .replace(/\{total\}/g, String(total))
      .replace(/\{date\}/g, new Date().toLocaleDateString())
      .replace(/\{file\}/g, baseName(fileName));

  const apply = async () => {
    await allMeasured();
    let pages = scopePages(scope, range);
    if (skipFirst) pages = pages.filter((p) => p !== actions.get().pages[0]);
    if (!pages.length || !format.trim()) return;
    const all = actions.get().pages;
    const total = all.length + start - 1;
    const objs = pages.map((p) => {
      const n = all.indexOf(p) + start;
      const text = render(n, total);
      const box = measureText({ text, font: 'sans', size, bold: false, italic: false });
      const x = pos[1] === 'l' ? margin : pos[1] === 'r' ? p.w - margin - box.w : (p.w - box.w) / 2;
      const y = pos[0] === 't' ? margin - box.h / 2 : p.h - margin - box.h / 2;
      return textObj(p, { text, size, color, x, y });
    });
    commit((s) => ({ objects: [...s.objects, ...objs] }));
    close();
  };

  return (
    <Modal
      title="Page numbers & header/footer"
      onClose={close}
      width={500}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Add to pages
          </Button>
        </>
      }
    >
      <div className="pn-layout">
        <div className="pn-page" aria-label="Position">
          {POSITIONS.map((p) => (
            <button key={p} type="button" className={`pn-slot pn-${p} ${pos === p ? 'sel' : ''}`} onClick={() => setPos(p)} aria-label={p}>
              {pos === p ? render(start, 12).slice(0, 14) : ''}
            </button>
          ))}
        </div>
        <div className="pn-fields">
          <Field label="Text" hint="Tokens: {n} page, {total} pages, {date}, {file}">
            <input className="input" value={format} onChange={(e) => setFormat(e.target.value)} list="pn-formats" />
            <datalist id="pn-formats">
              {FORMATS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <div className="row">
            <Field label="Start at">
              <input className="input" type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} />
            </Field>
            <Field label="Size">
              <input className="input" type="number" min={5} max={72} value={size} onChange={(e) => setSize(Number(e.target.value) || 10)} />
            </Field>
            <Field label="Color">
              <ColorButton tip="Color" kind="text" value={color} onChange={(c) => c && setColor(c)} />
            </Field>
          </div>
          <Slider label="Margin" value={margin} min={10} max={90} onChange={setMargin} format={(v) => `${v}pt`} />
        </div>
      </div>
      <ScopePicker scope={scope} setScope={setScope} range={range} setRange={setRange} />
      <Toggle checked={skipFirst} onChange={setSkipFirst} label="Skip the first page (cover)" />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Properties                                                           */
/* ------------------------------------------------------------------ */

function PropertiesDialog() {
  const s = useStore();
  const [meta, setLocal] = useState<DocMeta>(s.meta);
  const [user, setUser] = useState(s.userName);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const page = s.pages[s.currentPage];
  const primary = s.pages[0] ? s.docs[s.pages[0].src] : undefined;

  useEffect(() => {
    primary?.pdf
      .getMetadata()
      .then((m) => setInfo(m.info as Record<string, unknown>))
      .catch(() => setInfo(null));
  }, [primary]);

  const pw = page ? (page.rotation % 180 ? page.h : page.w) : 0;
  const ph = page ? (page.rotation % 180 ? page.w : page.h) : 0;
  const save = () => {
    const changed = (Object.keys(meta) as (keyof DocMeta)[]).some((k) => meta[k] !== s.meta[k]);
    if (changed) setMeta(meta);
    if (user.trim() && user !== s.userName) setUserName(user.trim());
    close();
  };
  const field = (k: keyof DocMeta, label: string) => (
    <Field label={label}>
      <input className="input" value={meta[k]} onChange={(e) => setLocal({ ...meta, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Modal
      title="Document properties"
      onClose={close}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save properties
          </Button>
        </>
      }
    >
      <dl className="facts">
        <dt>File</dt>
        <dd>{s.fileName}</dd>
        <dt>Pages</dt>
        <dd>{s.pages.length}</dd>
        <dt>Page size</dt>
        <dd>
          {(pw / 72).toFixed(2)} × {(ph / 72).toFixed(2)} in ({Math.round((pw / 72) * 25.4)} × {Math.round((ph / 72) * 25.4)} mm)
        </dd>
        {primary && (
          <>
            <dt>Original size</dt>
            <dd>{formatBytes(primary.bytes.length)}</dd>
          </>
        )}
        {typeof info?.PDFFormatVersion === 'string' && (
          <>
            <dt>PDF version</dt>
            <dd>{info.PDFFormatVersion}</dd>
          </>
        )}
        {typeof info?.Producer === 'string' && info.Producer && (
          <>
            <dt>Producer</dt>
            <dd>{info.Producer}</dd>
          </>
        )}
        {primary?.password !== undefined && (
          <>
            <dt>Security</dt>
            <dd>
              <Lock size={12} /> Password protected
            </dd>
          </>
        )}
      </dl>
      {field('title', 'Title')}
      {field('author', 'Author')}
      {field('subject', 'Subject')}
      {field('keywords', 'Keywords')}
      <Field label="Your name" hint="Shown as the author of comments you add.">
        <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Save with options                                                    */
/* ------------------------------------------------------------------ */

function SaveDialog() {
  const fileName = useStore((s) => s.fileName);
  const [name, setName] = useState(baseName(fileName) || 'Document');
  const [flattenForms, setFlattenForms] = useState(false);
  const [flattenComments, setFlattenComments] = useState(false);
  const [protect, setProtect] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const mismatch = protect && pw2.length > 0 && pw !== pw2;
  const valid = !protect || (pw.length >= 4 && pw === pw2);

  const go = () => {
    if (!valid) return;
    close();
    void saveDocument({
      saveAs: true,
      copy: protect,
      name: `${name}.pdf`,
      flattenForms,
      flattenComments,
      userPassword: protect ? pw : undefined,
    });
  };

  return (
    <Modal
      title="Save with options"
      onClose={close}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={!valid}>
            {protect ? 'Save protected copy' : 'Save'}
          </Button>
        </>
      }
    >
      <Field label="File name">
        <div className="input-suffix">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <span>.pdf</span>
        </div>
      </Field>
      <Toggle checked={flattenForms} onChange={setFlattenForms} label="Flatten form fields (no longer fillable)" />
      <Toggle checked={flattenComments} onChange={setFlattenComments} label="Flatten comments into the page" />
      <Toggle checked={protect} onChange={setProtect} label="Require a password to open" />
      {protect && (
        <div className="row">
          <Field label="Password" hint={pw && pw.length < 4 ? 'At least 4 characters' : undefined}>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm" hint={mismatch ? "Passwords don't match" : undefined}>
            <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      )}
      {protect && <p className="muted small">Encrypted with AES-256. Without the password the file can't be opened, so keep it somewhere safe.</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Password prompt for encrypted files                                  */
/* ------------------------------------------------------------------ */

function PasswordDialog({ name, retry, resolve }: { name: string; retry: boolean; resolve: (pw: string | null) => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal
      title="Password required"
      onClose={() => resolve(null)}
      width={400}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={() => resolve(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => resolve(pw)}>
            Open
          </Button>
        </>
      }
    >
      <p>
        <strong>{name}</strong> is protected. Enter its password to open it.
      </p>
      <Field label="Password" hint={retry ? <span className="error">That password is incorrect. Try again.</span> : undefined}>
        <input className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && resolve(pw)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Export images                                                        */
/* ------------------------------------------------------------------ */

function ExportImagesDialog() {
  const pageSel = useStore((s) => s.pageSelection);
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState('150');
  const [scope, setScope] = useState<'all' | 'current' | 'selected'>(pageSel.length > 1 ? 'selected' : 'all');
  const go = () => {
    const s = actions.get();
    const ids = scope === 'current' ? [s.pages[s.currentPage].id] : scope === 'selected' ? s.pages.filter((p) => pageSel.includes(p.id)).map((p) => p.id) : undefined;
    close();
    void exportImages({ format, dpi: Number(dpi), pageIds: ids });
  };
  return (
    <Modal
      title="Export pages as images"
      onClose={close}
      width={420}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go}>
            Export
          </Button>
        </>
      }
    >
      <Field label="Format">
        <Segmented value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }]} />
      </Field>
      <Field label="Resolution">
        <Segmented
          value={dpi}
          onChange={setDpi}
          options={[
            { value: '72', label: '72 dpi' },
            { value: '150', label: '150 dpi' },
            { value: '300', label: '300 dpi' },
          ]}
        />
      </Field>
      <Field label="Pages">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'current', label: 'Current' },
            ...(pageSel.length ? [{ value: 'selected' as const, label: `Selected (${pageSel.length})` }] : []),
          ]}
        />
      </Field>
      <p className="muted small">Several pages download as a ZIP archive.</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                            */
/* ------------------------------------------------------------------ */

const SHORTCUTS: [string, string][] = [
  ['Select / Hand', 'V / H'],
  ['Edit text / Add text', 'E / T'],
  ['Highlight / Sticky note', 'U / N'],
  ['Draw / Rectangle / Ellipse', 'D / R / O'],
  ['Line / Arrow', 'L / A'],
  ['Insert image / Fill & sign', 'I / S'],
  ['Whiteout / Redact', 'W / X'],
  ['Open', `${MOD}+O`],
  ['Save / Save as', `${MOD}+S / ${MOD}+Shift+S`],
  ['Print', `${MOD}+P`],
  ['Undo / Redo', `${MOD}+Z / ${MOD}+Shift+Z`],
  ['Find', `${MOD}+F`],
  ['Zoom in / out / 100%', `${MOD}+= / ${MOD}+− / ${MOD}+0`],
  ['Fit width / Fit page', `${MOD}+1 / ${MOD}+2`],
  ['Copy / Paste / Duplicate', `${MOD}+C / ${MOD}+V / ${MOD}+D`],
  ['Delete selection', 'Delete'],
  ['Nudge selection', 'Arrows (Shift = 10pt)'],
  ['Next / previous page', 'PgDn / PgUp'],
  ['Pan while held', 'Space + drag'],
  ['Cancel / back to Select', 'Esc'],
];

function ShortcutsDialog() {
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={480}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>
                {b.split(' / ').map((k, i) => (
                  <span key={i}>
                    {i > 0 && <span className="muted"> / </span>}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
