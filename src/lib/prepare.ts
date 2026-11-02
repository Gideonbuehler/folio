/**
 * Preparing a signature request: the signers, and the fields each of them
 * fills in. The request (the envelope) is part of the document, so changes
 * to it are undoable and saved with the file; this module holds the panel's
 * own state and the editing actions.
 */
import { create } from 'zustand';
import { actions, commit, setTool, toast, useStore } from '../store';
import type { FieldObj, FieldTool } from '../types';
import { isEmail, ROLE_LABEL, SIGNER_COLORS, type Envelope, type SignRole, type Signer } from './envelope';
import { namesInUse, primeFieldNames } from './forms';
import { askConfirm } from './native';
import { baseName, uid } from './util';

const { get } = actions;

interface PrepareState {
  open: boolean;
  /** The signer new fields are for. */
  signer: string | null;
  /** The kind of field being placed. */
  role: SignRole | null;
}

export const usePrepare = create<PrepareState>()(() => ({ open: false, signer: null, role: null }));

const ROLE_TOOL: Record<SignRole, FieldTool> = {
  signature: 'fieldSignature',
  initials: 'fieldSignature',
  date: 'fieldText',
  name: 'fieldText',
  text: 'fieldText',
  checkbox: 'fieldCheckbox',
};

/** Size of a field placed with a click. */
const ROLE_SIZE: Record<SignRole, [number, number]> = {
  signature: [180, 46],
  initials: [72, 40],
  date: [110, 22],
  name: [170, 22],
  text: [170, 22],
  checkbox: [14, 14],
};

// Leaving the field tool (placing the field, Esc, another tool) ends placing.
useStore.subscribe((s, prev) => {
  const { role } = usePrepare.getState();
  if (role && s.tool !== prev.tool && s.tool !== ROLE_TOOL[role]) usePrepare.setState({ role: null });
  // Each tab has its own request; the panel belongs to the one it was opened for.
  if (s.activeTab !== prev.activeTab && usePrepare.getState().open) usePrepare.setState({ open: false, role: null });
});

function newSigner(env: Envelope | null): Signer {
  const used = new Set(env?.signers.map((s) => s.color));
  const color = SIGNER_COLORS.find((c) => !used.has(c)) ?? SIGNER_COLORS[(env?.signers.length ?? 0) % SIGNER_COLORS.length];
  return { id: uid(), name: '', email: '', color };
}

function draftEnvelope(): Envelope {
  const s = get();
  return {
    v: 1,
    id: uid(),
    title: s.meta.title || baseName(s.fileName) || 'Document',
    sender: { name: s.userName === 'Me' ? '' : s.userName, email: s.userEmail },
    signers: [],
    order: 'sequential',
    subject: '',
    message: '',
    fields: [],
    events: [],
    status: 'draft',
  };
}

/** Opens the Request signatures panel, starting a request if the document has none. */
export async function openPrepare() {
  const s = get();
  if (!s.pages.length) return;
  let env = s.envelope;
  if (env && env.status !== 'draft') {
    const sent = env.status === 'out' ? 'This document is already out for signature.' : 'This document has been signed by everyone.';
    if (!(await askConfirm(`${sent} Start a new signature request for it?`, 'New request'))) return;
    env = null;
  }
  if (!env) {
    const draft = draftEnvelope();
    draft.signers.push(newSigner(draft));
    commit(() => ({ envelope: draft }));
    env = draft;
  }
  usePrepare.setState({ open: true, signer: env.signers[0]?.id ?? null, role: null });
}

export function closePrepare() {
  usePrepare.setState({ open: false, role: null });
  if (get().tool !== 'select') setTool('select');
}

/** Changes the request as one undoable step. */
export function updateEnvelope(fn: (e: Envelope) => Envelope) {
  if (!get().envelope) return;
  commit((s) => ({ envelope: fn(s.envelope!) }));
}

export function addSigner() {
  const env = get().envelope;
  if (!env) return;
  const signer = newSigner(env);
  updateEnvelope((e) => ({ ...e, signers: [...e.signers, signer] }));
  usePrepare.setState({ signer: signer.id });
  return signer.id;
}

export function updateSigner(id: string, patch: Partial<Signer>) {
  updateEnvelope((e) => ({ ...e, signers: e.signers.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
}

/** Removes a signer and the fields placed for them. */
export function removeSigner(id: string) {
  commit((s) => ({
    envelope: s.envelope && { ...s.envelope, signers: s.envelope.signers.filter((x) => x.id !== id), fields: s.envelope.fields.filter((f) => f.signer !== id) },
    objects: s.objects.filter((o) => !(o.type === 'field' && o.signer === id)),
  }));
  const p = usePrepare.getState();
  if (p.signer === id) usePrepare.setState({ signer: get().envelope?.signers[0]?.id ?? null });
}

export function moveSigner(id: string, dir: -1 | 1) {
  updateEnvelope((e) => {
    const list = [...e.signers];
    const i = list.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return e;
    [list[i], list[j]] = [list[j], list[i]];
    return { ...e, signers: list };
  });
}

/** Starts placing a field of this kind for the selected signer. */
export function placeField(role: SignRole) {
  const env = get().envelope;
  let { signer } = usePrepare.getState();
  if (!env) return;
  if (!signer || !env.signers.some((s) => s.id === signer)) signer = env.signers[0]?.id ?? null;
  if (!signer) {
    toast('Add a signer first', 'error');
    return;
  }
  primeFieldNames();
  setTool(ROLE_TOOL[role]);
  usePrepare.setState({ signer, role });
}

function roleFieldName(role: SignRole) {
  const used = namesInUse();
  for (let n = 1; ; n++) {
    const name = `${ROLE_LABEL[role]} ${n}`;
    if (!used.has(name)) return name;
  }
}

/** What a field placed now gets for the request (signer, role, name), or null outside the panel. */
export function assignment(): Required<Pick<FieldObj, 'signer' | 'role' | 'name' | 'required'>> | null {
  const p = usePrepare.getState();
  const s = get();
  if (!p.open || !p.role || !p.signer || s.tool !== ROLE_TOOL[p.role]) return null;
  if (!s.envelope?.signers.some((x) => x.id === p.signer)) return null;
  return {
    signer: p.signer,
    role: p.role,
    name: roleFieldName(p.role),
    required: p.role !== 'text' && p.role !== 'checkbox',
  };
}

/** Click-to-place size for the field being placed for a signer, if any. */
export function assignedSize(): [number, number] | null {
  const { open, role } = usePrepare.getState();
  return open && role ? ROLE_SIZE[role] : null;
}

/** How many fields each signer has: placed now, or already in the file. */
export function fieldCounts(env: Envelope, objects: { type: string; signer?: string }[]) {
  const n: Record<string, number> = {};
  for (const f of env.fields) n[f.signer] = (n[f.signer] ?? 0) + 1;
  for (const o of objects) if (o.type === 'field' && o.signer) n[o.signer] = (n[o.signer] ?? 0) + 1;
  return n;
}

/** What still keeps the request from being sent, as sentences for the user. */
export function sendProblems(): string[] {
  const s = get();
  const env = s.envelope;
  if (!env) return ['There is no signature request.'];
  const out: string[] = [];
  if (!env.signers.length) out.push('Add at least one signer.');
  const counts = fieldCounts(env, s.objects);
  const seen = new Set<string>();
  env.signers.forEach((x, i) => {
    const who = x.name.trim() || `Signer ${i + 1}`;
    if (!x.name.trim()) out.push(`Signer ${i + 1} needs a name.`);
    if (!isEmail(x.email)) out.push(`${who} needs a valid email address.`);
    else if (seen.has(x.email.trim().toLowerCase())) out.push(`${who} has the same email address as another signer.`);
    seen.add(x.email.trim().toLowerCase());
    if (!counts[x.id]) out.push(`${who} has no fields yet. Place at least a signature field for them.`);
  });
  if (!s.userName.trim() || s.userName === 'Me') out.push('Enter your name, so signers know who is asking.');
  if (!isEmail(s.userEmail)) out.push('Enter your email address, so signers can send the document back.');
  return out;
}

