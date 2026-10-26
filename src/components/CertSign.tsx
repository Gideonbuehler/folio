import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, FileKey, ShieldAlert, ShieldCheck, ShieldX, SquareDashed, TriangleAlert } from 'lucide-react';
import { actions, useStore } from '../store';
import { openIdentity, WrongPassword, type CertInfo } from '../lib/certs';
import { drawSignatureBox, emptySignatureFields, endCertFlow, signAndSave, useCertFlow, type SignTarget } from '../lib/certflow';
import { currentSignatures, useSignatures } from '../lib/signatures';
import { signatureDate, type SignatureInfo } from '../lib/certsign';
import { readFileBytes } from '../lib/util';
import { Button, Field, Modal } from './ui';
import { savedSignatures } from './SignatureDialog';

const close = () => actions.set({ dialog: null });

const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { dateStyle: 'medium' });

function CertCard({ cert }: { cert: CertInfo }) {
  const now = Date.now();
  const expired = cert.notAfter.getTime() < now;
  const early = cert.notBefore.getTime() > now;
  return (
    <div className="cert-card">
      <BadgeCheck size={22} className="cert-icon" />
      <div className="cert-lines">
        <strong>{cert.name}</strong>
        {(cert.subject.E || cert.subject.O) && <span className="muted small">{[cert.subject.E, cert.subject.O].filter(Boolean).join(' · ')}</span>}
        <span className="muted small">
          Issued by {cert.selfSigned ? 'itself (self-signed)' : cert.issuerName} · valid {fmtDate(cert.notBefore)} – {fmtDate(cert.notAfter)}
        </span>
        {(expired || early) && (
          <span className="error small">
            <TriangleAlert size={12} /> This certificate is {expired ? 'expired' : 'not valid yet'}.
          </span>
        )}
        {cert.selfSigned && !expired && (
          <span className="small cert-note">Self-signed: readers can check that the document wasn't changed, but not who signed it.</span>
        )}
      </div>
    </div>
  );
}

/** Sign with a digital ID (.pfx / .p12). */
export function CertSignDialog() {
  const fileName = useStore((s) => s.fileName);
  const box = useCertFlow((s) => s.box);
  const identity = useCertFlow((s) => s.identity);
  const idFile = useCertFlow((s) => s.idFile);
  const pages = useStore((s) => s.pages);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [fields, setFields] = useState<SignTarget[] | null>(null);
  const [target, setTarget] = useState<string>(box ? 'box' : '');
  const [sigs] = useState(savedSignatures);
  const [image, setImage] = useState<string | null>(() => savedSignatures()[0] ?? null);
  const [name, setName] = useState(identity?.cert.name ?? '');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    emptySignatureFields().then((f) => {
      if (!alive) return;
      setFields(f);
      setTarget((t) => t || (f[0]?.key ?? ''));
    });
    return () => {
      alive = false;
    };
  }, []);

  const unlock = async () => {
    if (!file || unlocking) return;
    setUnlocking(true);
    setError(null);
    try {
      const id = await openIdentity(await readFileBytes(file), password);
      useCertFlow.setState({ identity: id, idFile: file.name });
      setName((n) => n || id.cert.name);
    } catch (e) {
      setError(e instanceof WrongPassword ? 'Wrong password. Try again.' : (e as Error).message);
      setTimeout(() => pwRef.current?.select(), 0);
    } finally {
      // The password is only needed to open the file once.
      setPassword('');
      setUnlocking(false);
    }
  };

  const cancel = () => {
    endCertFlow();
    close();
  };

  const expired = identity ? identity.cert.notAfter.getTime() < Date.now() || identity.cert.notBefore.getTime() > Date.now() : false;
  const canSign = !!identity && !expired && !!target && !!name.trim();
  const sign = async () => {
    if (!canSign) return;
    close();
    const ok = await signAndSave({ identity: identity!, target, image, name: name.trim(), reason: reason.trim(), location: location.trim() });
    // Back to the dialog if the save was cancelled.
    if (ok === false && useCertFlow.getState().identity) actions.set({ dialog: { kind: 'certSign' } });
  };

  const boxPage = box ? pages.findIndex((p) => p.id === box.page) + 1 : 0;
  const options: SignTarget[] = [...(box && boxPage ? [{ key: 'box', label: `New signature box on page ${boxPage}` }] : []), ...(fields ?? [])];

  return (
    <Modal
      title="Sign with certificate"
      onClose={cancel}
      width={540}
      footer={
        <>
          <span className="muted small cert-footnote">Signing saves a copy of {fileName}. Any later change to that copy invalidates the signature.</span>
          <span className="spacer" />
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={sign} disabled={!canSign}>
            Sign and save…
          </Button>
        </>
      }
    >
      <Field label="Where the signature goes">
        <div className="row cert-target">
          {options.length > 0 && (
            <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Signature location">
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <Button onClick={drawSignatureBox}>
            <SquareDashed size={15} /> {box ? 'Draw again' : 'Draw a box on the page'}
          </Button>
        </div>
      </Field>

      <Field label="Digital ID (.pfx or .p12)">
        {identity ? (
          <div className="cert-unlocked">
            <CertCard cert={identity.cert} />
            <Button
              variant="ghost"
              onClick={() => {
                useCertFlow.setState({ identity: null, idFile: null });
                setFile(null);
              }}
            >
              Use another
            </Button>
          </div>
        ) : (
          <div className="cert-open">
            <label className="btn btn-default cert-file">
              <FileKey size={15} /> {file ? file.name : idFile ?? 'Choose a digital ID…'}
              <input
                type="file"
                accept=".pfx,.p12,application/x-pkcs12"
                hidden
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                  setTimeout(() => pwRef.current?.focus(), 0);
                }}
              />
            </label>
            {file && (
              <div className="row">
                <input
                  ref={pwRef}
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder="Password of the digital ID"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void unlock()}
                  aria-label="Digital ID password"
                />
                <Button variant="primary" onClick={unlock} disabled={unlocking}>
                  {unlocking ? 'Opening…' : 'Open'}
                </Button>
              </div>
            )}
            {error && <span className="error small">{error}</span>}
            <span className="muted small">The ID and its password stay on this device and are forgotten once you've signed.</span>
          </div>
        )}
      </Field>

      <Field label="Appearance">
        <div className="cert-looks">
          {sigs.map((s) => (
            <button key={s} type="button" className={`cert-look ${image === s ? 'sel' : ''}`} onClick={() => setImage(s)} aria-label="Use this signature">
              <img src={s} alt="Saved signature" />
            </button>
          ))}
          <button type="button" className={`cert-look text ${image === null ? 'sel' : ''}`} onClick={() => setImage(null)}>
            Name only
          </button>
        </div>
        {!sigs.length && <span className="muted small">Signatures you save in Fill & sign can be shown here too.</span>}
      </Field>

      <div className="row">
        <Field label="Name shown">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Reason (optional)">
          <input className="input" value={reason} placeholder="e.g. I approve this document" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <Field label="Location (optional)">
        <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Signatures of the open document                                      */
/* ------------------------------------------------------------------ */

const STATE_TEXT: Record<SignatureInfo['state'], string> = {
  valid: 'Signature is valid. The document has not been changed since it was signed.',
  modified: 'Signature is valid for the version that was signed, but the document was changed afterwards.',
  invalid: 'Signature is invalid: the document was altered after signing, or the signature is damaged.',
  unknown: "Signature couldn't be checked",
};

function useOpenSignatures() {
  const byDoc = useSignatures((s) => s.byDoc);
  const srcs = useStore((s) => s.pages.map((p) => p.src).join('|'));
  return currentSignatures(byDoc, srcs ? srcs.split('|') : []);
}

/** A bar over the page showing who signed and whether the document still matches. */
export function SignatureBar() {
  const sigs = useOpenSignatures();
  const dirty = useStore((s) => s.dirty);
  if (!sigs.length) return null;
  const worst = sigs.some((s) => s.state === 'invalid') ? 'invalid' : sigs.some((s) => s.state === 'unknown') ? 'unknown' : sigs.some((s) => s.state === 'modified') ? 'modified' : 'valid';
  // The newest signature is the one that covers the most.
  const last = [...sigs].sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0))[0];
  const Icon = worst === 'valid' ? ShieldCheck : worst === 'invalid' ? ShieldX : ShieldAlert;
  const summary =
    sigs.length === 1
      ? `Signed by ${last.signer}${last.time ? ` on ${last.time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`
      : `${sigs.length} signatures, latest by ${last.signer}`;
  const status =
    worst === 'valid'
      ? 'valid, unchanged since signing'
      : worst === 'modified'
        ? 'changed after signing'
        : worst === 'invalid'
          ? 'invalid'
          : "couldn't be checked";
  return (
    <div className={`sig-bar s-${worst}`} role="status">
      <Icon size={16} />
      <span>
        <strong>{summary}</strong> · {status}
        {dirty && <em> · saving your edits will remove the signature{sigs.length === 1 ? '' : 's'}</em>}
      </span>
      <button type="button" className="sig-bar-btn" onClick={() => actions.set({ dialog: { kind: 'signatures' } })}>
        Details
      </button>
    </div>
  );
}

export function SignaturesDialog() {
  const sigs = useOpenSignatures();
  return (
    <Modal title="Signatures" onClose={close} width={520}>
      {!sigs.length && <p className="muted">This document has no digital signatures.</p>}
      <ul className="sig-list">
        {sigs.map((s) => {
          const Icon = s.state === 'valid' ? ShieldCheck : s.state === 'invalid' ? ShieldX : ShieldAlert;
          return (
            <li key={s.id} className={`sig-item s-${s.state}`}>
              <Icon size={20} />
              <div className="sig-lines">
                <strong>{s.signer}</strong>
                <span>{STATE_TEXT[s.state]}{s.problem ? ` (${s.problem})` : ''}</span>
                {s.state === 'modified' && s.laterUpdates > 0 && (
                  <span className="muted small">
                    {s.laterUpdates} later update{s.laterUpdates === 1 ? '' : 's'} to the file (for example another signature).
                  </span>
                )}
                <span className="muted small">
                  {s.time ? `Signed ${signatureDate(s.time)}` : 'Signing time unknown'}
                  {s.timestamped ? ' · with a timestamp' : ''} · field {s.field || '(unnamed)'}
                </span>
                {(s.reason || s.location) && <span className="muted small">{[s.reason && `Reason: ${s.reason}`, s.location && `Location: ${s.location}`].filter(Boolean).join(' · ')}</span>}
                {s.cert && (
                  <span className="muted small">
                    Certificate issued by {s.cert.selfSigned ? 'itself (self-signed)' : s.cert.issuerName}, valid {fmtDate(s.cert.notBefore)} – {fmtDate(s.cert.notAfter)}
                    {s.cert.subject.E ? ` · ${s.cert.subject.E}` : ''}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {sigs.length > 0 && (
        <p className="muted small">
          Folio checks that the signed bytes are unchanged and that the signature matches the signer's certificate. It doesn't check certificate authorities or
          revocation, so it can't confirm the signer's identity.
        </p>
      )}
    </Modal>
  );
}
