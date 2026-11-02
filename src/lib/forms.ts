/**
 * Designing form fields: naming new fields, and turning the designed fields
 * into real ones in the open document so they can be filled right away.
 */
import type { FieldKind, FieldObj, PageItem, Rect } from '../types';
import { actions, commit, toast } from '../store';
import { loadSource } from './pdfjs';
import { uid } from './util';
import { assignment } from './prepare';

const { get, set } = actions;

const STEM: Record<FieldKind, string> = {
  text: 'Text',
  multiline: 'Text',
  checkbox: 'Check Box',
  radio: 'Group',
  dropdown: 'Dropdown',
  signature: 'Signature',
};

/** Names of fields already in the open files, by source document id. */
const sourceNames = new Map<string, Set<string>>();

/** Reads the existing fields' names so new ones don't collide with them. */
export function primeFieldNames() {
  for (const doc of Object.values(get().docs)) {
    if (sourceNames.has(doc.id)) continue;
    sourceNames.set(doc.id, new Set());
    doc.pdf
      .getFieldObjects()
      // pdf.js 6 returns a Map; older versions a plain object.
      .then((f: unknown) => sourceNames.set(doc.id, new Set(f instanceof Map ? [...f.keys()] : Object.keys(f ?? {}))))
      .catch(() => {});
  }
}

export function namesInUse() {
  const names = new Set<string>();
  const s = get();
  const srcs = new Set(s.pages.map((p) => p.src));
  for (const [id, set] of sourceNames) if (srcs.has(id)) set.forEach((n) => names.add(n));
  for (const o of s.objects) if (o.type === 'field') names.add(o.name);
  return names;
}

export function uniqueFieldName(kind: FieldKind) {
  const used = namesInUse();
  for (let n = 1; ; n++) {
    const name = `${STEM[kind]}${kind === 'checkbox' ? ' ' : ''}${n}`;
    if (!used.has(name)) return name;
  }
}

/** A new field; radio buttons join the group of the radio button placed just before. */
export function newField(kind: FieldKind, page: PageItem, r: Rect): FieldObj {
  const s = get();
  const base = { id: uid(), page: page.id, created: Date.now(), author: s.userName, opacity: 1, type: 'field' as const, kind, ...r, fontSize: 0 };
  // Placing a field for a signer of a signature request.
  const a = assignment();
  if (a) return { ...base, ...a };
  if (kind === 'radio') {
    const last = [...s.objects].reverse().find((o): o is FieldObj => o.type === 'field');
    if (last?.kind === 'radio' && last.page === page.id) {
      const group = s.objects.filter((o): o is FieldObj => o.type === 'field' && o.kind === 'radio' && o.name === last.name);
      const choices = new Set(group.map((o) => o.choice));
      let n = group.length + 1;
      while (choices.has(`Choice${n}`)) n++;
      return { ...base, name: last.name, choice: `Choice${n}`, w: last.w, h: last.h };
    }
    return { ...base, name: uniqueFieldName('radio'), choice: 'Choice1' };
  }
  if (kind === 'dropdown') return { ...base, name: uniqueFieldName(kind), options: ['Option 1', 'Option 2', 'Option 3'] };
  return { ...base, name: uniqueFieldName(kind) };
}

/**
 * Writes the designed fields into the document (as saving would) and reopens
 * it in place, so they can be filled in Folio. Other objects stay editable,
 * and Undo brings the designed fields back.
 */
export async function makeFieldsFillable() {
  const s = get();
  const fields = s.objects.filter((o): o is FieldObj => o.type === 'field');
  if (!fields.length || s.busy) return;
  set({ busy: 'Creating form fields…', editing: null });
  try {
    const { buildPdf } = await import('./export');
    // User rotation is kept out of the file so page space stays the same.
    const flat = s.pages.map((p) => ({ ...p, rotation: 0 as const }));
    const res = await buildPdf({ docs: s.docs, pages: flat, objects: fields, meta: s.meta, envelope: s.envelope });
    const { doc, pages } = await loadSource(res.bytes, s.fileName, async () => null);
    const next = s.pages.map((p, i) => ({ ...pages[i], id: p.id, rotation: p.rotation }));
    const gone = new Set(fields.map((f) => f.id));
    set((st) => ({ docs: { ...st.docs, [doc.id]: doc } }));
    // Signature request fields now live in the file, under the names they got there.
    commit((st) => ({ pages: next, objects: st.objects.filter((o) => !gone.has(o.id)), envelope: res.envelope ?? st.envelope }));
    set((st) => ({ selection: st.selection.filter((id) => !gone.has(id)), tool: 'select' }));
    sourceNames.set(doc.id, new Set(fields.map((f) => f.name)));
    toast(`${fields.length} form field${fields.length === 1 ? ' is' : 's are'} ready to fill`, 'success');
    for (const w of res.warnings) toast(w, 'info');
  } catch (e) {
    console.error(e);
    toast(`Couldn't create the form fields: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}
