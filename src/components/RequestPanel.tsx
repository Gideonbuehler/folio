/**
 * Signature requests, the sender's side: the panel for choosing signers and
 * placing their fields, the send dialog, and the list of requests sent.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BellRing,
  CalendarDays,
  CircleCheck,
  Clock,
  FileSignature,
  Mail,
  PenLine,
  Plus,
  Send,
  SquareCheckBig,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { actions, setUserEmail, setUserName, useStore } from '../store';
import { declined, isEmail, pendingSigners, ROLE_LABEL, signedAt, signerById, signersUp, when, type Envelope, type SignRole, type Signer } from '../lib/envelope';
import {
  addSigner,
  closePrepare,
  fieldCounts,
  moveSigner,
  placeField,
  removeSigner,
  sendProblems,
  updateEnvelope,
  updateSigner,
  usePrepare,
} from '../lib/prepare';
import { finalizeRequest, forgetRequest, loadRequests, openLatest, remind, sendForSignature, useRequests, type TrackedRequest } from '../lib/requests';
import { mailMethodText } from '../lib/mail';
import { Button, IconButton, Modal, Toggle } from './ui';

const ROLE_ICON: Record<SignRole, ReactNode> = {
  signature: <FileSignature size={16} />,
  initials: <PenLine size={16} />,
  date: <CalendarDays size={16} />,
  name: <UserRound size={16} />,
  text: <TextCursorInput size={16} />,
  checkbox: <SquareCheckBig size={16} />,
};

const ROLES: SignRole[] = ['signature', 'initials', 'date', 'name', 'text', 'checkbox'];

/** Text input that changes the document only when editing ends (one undo step per edit). */
function LazyInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      {...rest}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** Right-hand panel for preparing a signature request. */
export function RequestPanel() {
  const open = usePrepare((s) => s.open);
  const env = useStore((s) => s.envelope);
  if (!open || !env || env.status !== 'draft') return null;
  return <PrepareBody env={env} />;
}

function PrepareBody({ env }: { env: Envelope }) {
  const { signer: active, role } = usePrepare();
  const objects = useStore((s) => s.objects);
  const userName = useStore((s) => s.userName);
  const userEmail = useStore((s) => s.userEmail);
  const counts = fieldCounts(env, objects);
  const current = env.signers.find((s) => s.id === active) ?? env.signers[0];

  return (
    <aside className="request-panel" aria-label="Request signatures">
      <div className="panel-head">
        <h3>Request signatures</h3>
        <IconButton tip="Close" onClick={closePrepare}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="request-body">
        <section>
          <div className="request-heading">
            <span>Signers</span>
            {env.signers.length > 1 && (
              <Toggle checked={env.order === 'sequential'} onChange={(v) => updateEnvelope((e) => ({ ...e, order: v ? 'sequential' : 'parallel' }))} label="In order" />
            )}
          </div>
          <ol className="signer-list">
            {env.signers.map((s, i) => (
              <SignerRow key={s.id} s={s} index={i} count={counts[s.id] ?? 0} active={s.id === current?.id} last={i === env.signers.length - 1} ordered={env.order === 'sequential'} />
            ))}
          </ol>
          <button type="button" className="btn btn-ghost add-signer" onClick={() => addSigner()}>
            <Plus size={16} /> Add signer
          </button>
          {env.signers.length > 1 && (
            <p className="muted small request-note">
              {env.order === 'sequential' ? 'Each signer passes the document on to the next.' : 'Everyone gets the document at once and sends their signed copy back to you.'}
            </p>
          )}
        </section>

        {current && (
          <section>
            <div className="request-heading">
              <span>
                Fields for <b style={{ color: current.color }}>{current.name.trim() || `Signer ${env.signers.indexOf(current) + 1}`}</b>
              </span>
            </div>
            <div className="role-grid">
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`role-btn ${role === r ? 'on' : ''}`}
                  style={{ '--signer': current.color } as React.CSSProperties}
                  onClick={() => {
                    usePrepare.setState({ signer: current.id });
                    placeField(r);
                  }}
                >
                  {ROLE_ICON[r]}
                  <span>{ROLE_LABEL[r]}</span>
                </button>
              ))}
            </div>
            <p className="muted small request-note">
              {role ? `Click on the page to place the ${ROLE_LABEL[role].toLowerCase()} field, or drag to size it.` : 'Choose a field, then click on the page where it goes.'}{' '}
              Date signed and Name fill in by themselves.
            </p>
          </section>
        )}

        <section>
          <div className="request-heading">
            <span>Message</span>
          </div>
          <LazyInput
            className="input"
            placeholder={`Please sign: ${env.title}`}
            aria-label="Email subject"
            value={env.subject}
            onCommit={(v) => updateEnvelope((e) => ({ ...e, subject: v }))}
          />
          <MessageBox env={env} />
        </section>

        <section>
          <div className="request-heading">
            <span>From</span>
          </div>
          <LazyInput className="input" placeholder="Your name" aria-label="Your name" value={userName === 'Me' ? '' : userName} onCommit={(v) => setUserName(v.trim() || 'Me')} />
          <LazyInput
            className={`input ${userEmail && !isEmail(userEmail) ? 'invalid' : ''}`}
            placeholder="Your email (signers send it back here)"
            aria-label="Your email"
            type="email"
            value={userEmail}
            onCommit={(v) => setUserEmail(v.trim())}
          />
        </section>
      </div>
      <div className="request-foot">
        <Button variant="primary" onClick={() => actions.set({ dialog: { kind: 'sendRequest' } })}>
          <Send size={16} /> Send for signature…
        </Button>
      </div>
    </aside>
  );
}

function MessageBox({ env }: { env: Envelope }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      className="input request-message"
      rows={4}
      placeholder="Message to the signers (optional)"
      value={draft ?? env.message}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => {
        if (draft !== null && draft !== env.message) updateEnvelope((e) => ({ ...e, message: draft }));
        setDraft(null);
      }}
    />
  );
}

function SignerRow({ s, index, count, active, last, ordered }: { s: Signer; index: number; count: number; active: boolean; last: boolean; ordered: boolean }) {
  return (
    <li className={`signer-row ${active ? 'active' : ''}`} style={{ '--signer': s.color } as React.CSSProperties} onPointerDown={() => usePrepare.setState({ signer: s.id })}>
      <span className="signer-dot" aria-hidden>
        {ordered ? index + 1 : ''}
      </span>
      <div className="signer-inputs">
        <LazyInput className="input" placeholder="Name" aria-label={`Signer ${index + 1} name`} value={s.name} onCommit={(v) => updateSigner(s.id, { name: v.trim() })} />
        <LazyInput
          className={`input ${s.email && !isEmail(s.email) ? 'invalid' : ''}`}
          placeholder="Email"
          type="email"
          aria-label={`Signer ${index + 1} email`}
          value={s.email}
          onCommit={(v) => updateSigner(s.id, { email: v.trim() })}
        />
        <span className="muted small">
          {count} field{count === 1 ? '' : 's'}
        </span>
      </div>
      <div className="signer-actions">
        {ordered && index > 0 && (
          <IconButton tip="Sign earlier" className="sm" onClick={() => moveSigner(s.id, -1)}>
            <ArrowUp size={14} />
          </IconButton>
        )}
        {ordered && !last && (
          <IconButton tip="Sign later" className="sm" onClick={() => moveSigner(s.id, 1)}>
            <ArrowDown size={14} />
          </IconButton>
        )}
        <IconButton tip="Remove signer and their fields" className="sm" onClick={() => removeSigner(s.id)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */

const close = () => actions.set({ dialog: null });

/** Last check before the request goes out. */
export function SendRequestDialog() {
  const env = useStore((s) => s.envelope);
  const [how, setHow] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    void mailMethodText().then(setHow);
  }, []);
  if (!env) return null;
  const problems = sendProblems();
  const first = env.order === 'sequential' ? env.signers.slice(0, 1) : env.signers;
  return (
    <Modal
      title="Send for signature"
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!problems.length || sending}
            onClick={async () => {
              setSending(true);
              close();
              if (await sendForSignature()) usePrepare.setState({ open: false, role: null });
            }}
          >
            <Mail size={16} /> Prepare email
          </Button>
        </>
      }
    >
      {problems.length ? (
        <div className="request-problems">
          <TriangleAlert size={18} />
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p>
            <b>{env.title}</b> goes to {first.map((s) => `${s.name} (${s.email})`).join(', ')}
            {env.order === 'sequential' && env.signers.length > 1 ? `, then ${env.signers.slice(1).map((s) => s.name).join(', then ')}` : ''}.
          </p>
          <p className="muted">{how}</p>
          <p className="muted small">
            Folio keeps a copy of what you send. When a signed copy comes back, open it in Folio: the signatures are added to your copy and every page is checked
            against what you sent. Nothing is uploaded anywhere.
          </p>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function statusOf(r: TrackedRequest): { icon: ReactNode; text: string; tone: string } {
  const env = r.envelope;
  const no = declined(env);
  if (env.status === 'completed') return { icon: <CircleCheck size={16} />, text: 'Completed', tone: 'done' };
  if (no) return { icon: <TriangleAlert size={16} />, text: `Declined by ${signerById(env, no.signer ?? '')?.name ?? 'a signer'}`, tone: 'bad' };
  const left = pendingSigners(env);
  if (!left.length) return { icon: <CircleCheck size={16} />, text: 'Everyone signed: ready to finalize', tone: 'ready' };
  const up = signersUp(env);
  return { icon: <Clock size={16} />, text: `Waiting for ${up.map((s) => s.name).join(', ')}`, tone: 'wait' };
}

export function RequestsDialog() {
  const list = useRequests((s) => s.list);
  useEffect(() => {
    void loadRequests();
  }, []);
  return (
    <Modal title="Signature requests" onClose={close} width={620}>
      {!list.length && <p className="muted">Requests you send for signature appear here, with who has signed so far.</p>}
      <ul className="request-list">
        {list.map((r) => (
          <RequestItem key={r.id} r={r} />
        ))}
      </ul>
      {list.length > 0 && <p className="muted small">Open a signed copy that comes back by email in Folio, and its signatures are added here.</p>}
    </Modal>
  );
}

function RequestItem({ r }: { r: TrackedRequest }) {
  const st = statusOf(r);
  const env = r.envelope;
  const changed = Object.entries(r.changes).filter(([, p]) => p.length);
  return (
    <li className={`request-item tone-${st.tone}`}>
      <div className="request-item-head">
        <span className="request-status">{st.icon}</span>
        <div className="request-item-title">
          <strong>{r.title}</strong>
          <span className="muted small">
            Sent {when(r.sentAt)} · {st.text}
          </span>
        </div>
      </div>
      <ul className="request-signers">
        {env.signers.map((s) => {
          const at = signedAt(env, s.id);
          return (
            <li key={s.id} style={{ '--signer': s.color } as React.CSSProperties}>
              <span className="signer-dot sm" aria-hidden />
              <span>{s.name}</span>
              <span className="muted small">{at ? `signed ${when(at)}` : 'not signed yet'}</span>
            </li>
          );
        })}
      </ul>
      {changed.map(([id, pages]) => (
        <p key={id} className="request-warning small">
          <TriangleAlert size={14} /> The copy from {signerById(env, id)?.name ?? 'a signer'} differed from what you sent on page {pages.join(', ')}.
        </p>
      ))}
      <div className="request-item-actions">
        {env.status === 'out' && !pendingSigners(env).length && !declined(env) && (
          <Button
            variant="primary"
            onClick={() => {
              close();
              void finalizeRequest(r.id);
            }}
          >
            <CircleCheck size={16} /> Finalize…
          </Button>
        )}
        <Button
          onClick={() => {
            close();
            void openLatest(r.id);
          }}
        >
          Open
        </Button>
        {env.status === 'out' && signersUp(env).length > 0 && (
          <Button onClick={() => void remind(r.id)}>
            <BellRing size={16} /> Remind
          </Button>
        )}
        <Button variant="ghost" onClick={() => void forgetRequest(r.id)}>
          Remove
        </Button>
      </div>
    </li>
  );
}

/** "Out for signature" on the start page. */
export function OutForSignature() {
  const list = useRequests((s) => s.list).filter((r) => r.envelope.status !== 'completed');
  useEffect(() => {
    void loadRequests();
  }, []);
  if (!list.length) return null;
  return (
    <section className="recent" aria-label="Out for signature">
      <div className="recent-head">
        <h2>Out for signature</h2>
        <button type="button" className="btn btn-ghost" onClick={() => actions.set({ dialog: { kind: 'requests' } })}>
          All requests
        </button>
      </div>
      <ul className="recent-list">
        {list.slice(0, 5).map((r) => {
          const st = statusOf(r);
          return (
            <li key={r.id} className="recent-item">
              <button type="button" className="recent-open" onClick={() => void openLatest(r.id)}>
                <span className={`request-status tone-${st.tone}`}>{st.icon}</span>
                <span className="recent-text">
                  <span className="recent-name">{r.title}</span>
                  <span className="recent-path">{st.text}</span>
                </span>
                <span className="recent-when">{when(r.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
