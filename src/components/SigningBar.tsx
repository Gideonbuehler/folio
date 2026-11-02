/**
 * Signature requests in an open document: the bar that says whose turn it is
 * and walks a signer through their fields, the clickable spots on the pages,
 * and the decline dialog.
 */
import { useEffect, useReducer, useState } from 'react';
import { BellRing, ChevronRight, CircleCheck, Clock, FileSignature, Mail, PenLine, TriangleAlert, X } from 'lucide-react';
import { actions, tabState, useStore } from '../store';
import type { PageItem } from '../types';
import { declined, pendingSigners, sameEmail, signedAt, signerById, signersUp, when, type Envelope } from '../lib/envelope';
import { findRequest, finalizeRequest, remind, sendFinal, useRequests } from '../lib/requests';
import {
  chooseSigner,
  currentSigner,
  declineSigning,
  finishSigning,
  goToNext,
  progress,
  signSpot,
  spotDone,
  startSigning,
  stopSigning,
  useFormsVersion,
  useSigning,
  type Spot,
} from '../lib/signing';
import { cssTransform } from './objects';
import { Button, Modal } from './ui';

/** Re-renders when the user types in a form field (values live in pdf.js, not the store). */
function useFormInput() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const on = () => bump();
    document.addEventListener('input', on, true);
    document.addEventListener('change', on, true);
    return () => {
      document.removeEventListener('input', on, true);
      document.removeEventListener('change', on, true);
    };
  }, []);
}

export function SigningBar() {
  const env = useStore((s) => s.envelope);
  const tab = useStore((s) => s.activeTab);
  const list = useRequests((s) => s.list);
  if (!env || env.status === 'draft' || !tab) return null;
  const record = list.find((r) => r.id === env.id);
  const tracked = !!record;
  if (env.status === 'completed' || record?.envelope.status === 'completed')
    return <CompletedBar env={record?.envelope ?? env} tab={tab} tracked={tracked && record?.via !== 'documenso'} remote={record?.via === 'folio-sign'} />;
  return <OutBar env={env} tab={tab} tracked={tracked} />;
}

function CompletedBar({ env, tab, tracked, remote }: { env: Envelope; tab: string; tracked: boolean; remote: boolean }) {
  const done = env.events.find((e) => e.type === 'completed');
  return (
    <div className="signing-bar tone-done" role="status">
      <CircleCheck size={16} />
      <span>
        <strong>Signed by everyone</strong>
        {done ? ` · completed ${when(done.at)}` : ''}
      </span>
      {tracked && (
        <button type="button" className="sig-bar-btn" onClick={() => void sendFinal(tab)}>
          <Mail size={14} /> {remote ? 'Send to signers' : 'Email to signers'}
        </button>
      )}
    </div>
  );
}

function OutBar({ env, tab, tracked }: { env: Envelope; tab: string; tracked: boolean }) {
  useFormInput();
  useFormsVersion();
  const userEmail = useStore((s) => s.userEmail);
  useStore((s) => s.objects);
  const state = useSigning((s) => s.byTab[tab]);
  useSigning((s) => s.spots[tab]);
  const report = useRequests((s) => s.reports[tab]);
  const no = declined(env);
  const up = signersUp(env);
  const signer = currentSigner(env, tab, userEmail);
  const me = signer ? signerById(env, signer) : undefined;
  const { mine, todo } = progress(tab);

  if (no) {
    const who = signerById(env, no.signer ?? '')?.name ?? 'A signer';
    return (
      <div className="signing-bar tone-bad" role="status">
        <TriangleAlert size={16} />
        <span>
          <strong>{who} declined to sign</strong>
          {no.note ? `: ${no.note}` : ''}
        </span>
      </div>
    );
  }

  // Guided signing.
  if (me && state?.active) {
    const doneCount = mine.length - todo.length;
    const required = todo.filter((x) => x.field.required).length;
    return (
      <div className="signing-bar tone-active" role="status" style={{ '--signer': me.color } as React.CSSProperties}>
        <PenLine size={16} />
        <span>
          <strong>{me.name}</strong> · {doneCount} of {mine.length} field{mine.length === 1 ? '' : 's'} done
          {required ? <em> · {required} required left</em> : ''}
        </span>
        {todo.length > 0 && (
          <button type="button" className="sig-bar-btn" onClick={() => goToNext(tab)}>
            Next <ChevronRight size={14} />
          </button>
        )}
        <button type="button" className={`sig-bar-btn ${required ? '' : 'primary'}`} onClick={() => void finishSigning()}>
          Finish
        </button>
        <button type="button" className="sig-bar-link" onClick={() => actions.set({ dialog: { kind: 'decline' } })}>
          Decline
        </button>
        <button type="button" className="sig-bar-x" aria-label="Stop signing" onClick={() => stopSigning(tab)}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // The sender looking at their request.
  if (tracked && !me) {
    const r = findRequest(env.id);
    const latest = r?.envelope ?? env;
    const left = pendingSigners(latest);
    const fresh = report?.newlySigned.map((id) => signerById(latest, id)?.name).filter(Boolean) ?? [];
    return (
      <div className={`signing-bar ${report?.changedPages.length ? 'tone-bad' : left.length ? 'tone-wait' : 'tone-done'}`} role="status">
        {report?.changedPages.length ? <TriangleAlert size={16} /> : left.length ? <Clock size={16} /> : <CircleCheck size={16} />}
        <span>
          {fresh.length > 0 && <strong>{fresh.join(' and ')} signed · </strong>}
          {left.length ? `Waiting for ${signersUp(latest).map((s) => s.name).join(', ')}` : 'Everyone has signed'}
          {report?.changedPages.length ? <em> · differs from what you sent on page {report.changedPages.join(', ')}</em> : ''}
        </span>
        {!left.length && r && r.via !== 'documenso' && (
          <button type="button" className="sig-bar-btn primary" onClick={() => void finalizeRequest(r.id)}>
            Finalize…
          </button>
        )}
        {left.length > 0 && r && (
          <button type="button" className="sig-bar-btn" onClick={() => void remind(r.id)}>
            <BellRing size={14} /> Remind
          </button>
        )}
        <button type="button" className="sig-bar-link" onClick={() => actions.set({ dialog: { kind: 'requests' } })}>
          Details
        </button>
      </div>
    );
  }

  // A signer who already signed, looking at their copy.
  const mineDone = !me && env.signers.find((s) => sameEmail(s.email, userEmail) && signedAt(env, s.id) !== undefined);
  if (mineDone && up.length) {
    return (
      <div className="signing-bar tone-done" role="status">
        <CircleCheck size={16} />
        <span>
          <strong>You signed {when(signedAt(env, mineDone.id)!)}</strong> · {env.order === 'sequential' ? 'now with' : 'waiting for'} {up.map((s) => s.name).join(', ')}
        </span>
      </div>
    );
  }

  if (!up.length) {
    return (
      <div className="signing-bar tone-done" role="status">
        <CircleCheck size={16} />
        <span>
          <strong>Everyone has signed.</strong> {env.sender.name} finalizes the document.
        </span>
      </div>
    );
  }

  // Someone opening a document they were asked to sign.
  const already = me ? undefined : env.signers.find((s) => signedAt(env, s.id) !== undefined && !up.includes(s));
  return (
    <div className="signing-bar tone-wait" role="status" style={me ? ({ '--signer': me.color } as React.CSSProperties) : undefined}>
      <FileSignature size={16} />
      <span>
        <strong>{env.sender.name}</strong> asked {me ? <strong>{me.name}</strong> : up.map((s) => s.name).join(' or ')} to sign
        {me ? ` · ${mine.length} field${mine.length === 1 ? '' : 's'}` : ''}
        {already && !me ? <em> · {already.name} has signed</em> : ''}
      </span>
      {up.length > 1 && (
        <select className="input signing-who" aria-label="Signing as" value={signer ?? ''} onChange={(e) => chooseSigner(tab, e.target.value)}>
          <option value="" disabled>
            Who are you?
          </option>
          {up.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {me && (
        <button type="button" className="sig-bar-btn primary" onClick={() => startSigning(tab, me.id)}>
          Start signing
        </button>
      )}
      {me && (
        <button type="button" className="sig-bar-link" onClick={() => actions.set({ dialog: { kind: 'decline' } })}>
          Decline
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** The request's fields on one page: "Sign here" buttons for the signer, and a guard over everyone else's. */
export function SignSpots({ page, zoom }: { page: PageItem; zoom: number }) {
  const tab = useStore((s) => s.activeTab);
  const env = useStore((s) => s.envelope);
  const userEmail = useStore((s) => s.userEmail);
  const objects = useStore((s) => s.objects);
  const spots = useSigning((s) => (tab ? s.spots[tab] : undefined));
  const active = useSigning((s) => (tab ? !!s.byTab[tab]?.active : false));
  useFormsVersion();
  useFormInput();
  if (!tab || !env || env.status !== 'out' || !spots?.length) return null;
  const here = spots.filter((s) => s.page === page.id);
  if (!here.length) return null;
  const d = tabState(tab);
  if (!d) return null;
  const signer = currentSigner(env, tab, userEmail);
  void objects;
  return (
    <div className="sign-spots" style={{ transform: cssTransform(page, zoom) }}>
      {here.map((spot) => (
        <SpotView key={spot.annot} spot={spot} zoom={zoom} env={env} mine={spot.field.signer === signer} active={active} done={spotDone(d, spot)} tab={tab} />
      ))}
    </div>
  );
}

function SpotView({ spot, zoom, env, mine, active, done, tab }: { spot: Spot; zoom: number; env: Envelope; mine: boolean; active: boolean; done: boolean; tab: string }) {
  const r = spot.rect;
  const who = signerById(env, spot.field.signer);
  const style = {
    left: r.x * zoom,
    top: r.y * zoom,
    width: r.w * zoom,
    height: r.h * zoom,
    '--signer': who?.color ?? '#888',
  } as React.CSSProperties;
  const signs = spot.field.role === 'signature' || spot.field.role === 'initials';
  if (!mine) return <div className="sign-spot guard" style={style} data-tip={`For ${who?.name ?? 'another signer'}`} />;
  if (signs) {
    return (
      <button
        type="button"
        className={`sign-spot sign ${done ? 'done' : ''} ${spot.field.required ? 'required' : ''}`}
        style={style}
        data-tip={done ? 'Click to sign again' : undefined}
        onClick={() => {
          if (!useSigning.getState().byTab[tab]?.active) startSigning(tab, spot.field.signer);
          signSpot(spot);
        }}
      >
        {!done && (
          <span style={{ fontSize: Math.max(9, Math.min(14, r.h * zoom * 0.32)) }}>
            {spot.field.role === 'initials' ? 'Initial' : 'Sign'} <ChevronRight size={12} />
          </span>
        )}
      </button>
    );
  }
  if (spot.field.role === 'date') return <div className={`sign-spot fixed ${active ? 'outlined' : ''}`} style={style} data-tip="Filled in with the date you sign" />;
  return <div className={`sign-spot field ${active ? 'outlined' : ''} ${active && !done && spot.field.required ? 'todo' : ''}`} style={style} />;
}

/* ------------------------------------------------------------------ */

export function DeclineDialog() {
  const [reason, setReason] = useState('');
  const close = () => actions.set({ dialog: null });
  return (
    <Modal
      title="Decline to sign"
      onClose={close}
      width={440}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              close();
              void declineSigning(reason);
            }}
          >
            Decline
          </Button>
        </>
      }
    >
      <p className="muted">The sender gets an email saying you declined. You can tell them why:</p>
      <textarea className="input request-message" rows={3} value={reason} placeholder="Reason (optional)" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </Modal>
  );
}
