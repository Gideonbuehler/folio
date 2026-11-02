/**
 * Folio opened from a Folio Sign signing link: only the document, the
 * signing bar and the signature dialog, and a page saying how it went.
 */
import { useEffect, type ReactNode } from 'react';
import { CircleCheck, Clock, Download, FileSignature, Loader2, TriangleAlert } from 'lucide-react';
import { useStore } from '../store';
import { downloadCopy, startLink, useLink } from '../lib/linksign';
import type { LinkInfo } from '../lib/foliosign';
import { Viewer } from './Viewer';
import { SigningBar } from './SigningBar';
import { Button } from './ui';

function Brand({ title }: { title?: string }) {
  return (
    <header className="header link-header">
      <div className="header-left">
        <div className="brand" aria-label="Folio">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <rect x="5" y="2" width="22" height="28" rx="5" fill="var(--accent)" />
            <path d="M11 10h10M11 15.5h10M11 21h6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>Folio</span>
        </div>
      </div>
      {title && <div className="header-center link-title">{title}</div>}
      <div className="header-right" />
    </header>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="link-status">
      <div className="link-card">
        <span className="link-icon">{icon}</span>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function statusCard(info: LinkInfo | null) {
  const from = info ? `${info.sender.name} (${info.sender.email})` : 'the sender';
  switch (info?.state) {
    case 'waiting': {
      const before = info.signers.filter((s) => s.status !== 'signed' && s.name !== info.signer.name).map((s) => s.name);
      return (
        <Card icon={<Clock size={28} />} title="It isn't your turn yet">
          <p>
            {before.length ? `${before.join(', ')} sign${before.length === 1 ? 's' : ''} before you. ` : ''}You'll get an email when it's your turn.
          </p>
        </Card>
      );
    }
    case 'signed':
      return (
        <Card icon={<CircleCheck size={28} />} title="You've signed this document">
          <p>{from} will send everyone the signed document once all signers have signed.</p>
        </Card>
      );
    case 'declined':
      return (
        <Card icon={<TriangleAlert size={28} />} title="This request was declined">
          <p>Contact {from} if you have questions.</p>
        </Card>
      );
    case 'completed':
      return (
        <Card icon={<CircleCheck size={28} />} title="Everyone has signed">
          <p>The signed document, with a summary of who signed and when, is ready.</p>
          <Button variant="primary" onClick={() => void downloadCopy()}>
            <Download size={16} /> Download the signed document
          </Button>
        </Card>
      );
    default:
      return (
        <Card icon={<TriangleAlert size={28} />} title="This request was cancelled">
          <p>Contact {from} if you have questions.</p>
        </Card>
      );
  }
}

export function LinkApp({ extras }: { extras: ReactNode }) {
  const { phase, info, error } = useLink();
  const hasDoc = useStore((s) => s.pages.length > 0);
  useEffect(() => {
    void startLink();
  }, []);

  let body: ReactNode;
  if (phase === 'loading' || (phase === 'signing' && !hasDoc)) {
    body = (
      <Card icon={<Loader2 size={28} className="spin" />} title="Opening the document…" />
    );
  } else if (phase === 'signing') {
    body = (
      <main className="main">
        <Viewer />
        <SigningBar />
      </main>
    );
  } else if (phase === 'done') {
    body = (
      <Card icon={<CircleCheck size={28} />} title="Thank you, you've signed">
        <p>{info ? `${info.sender.name} has been told. ` : ''}Once everyone has signed, you'll get the signed document by email.</p>
        <Button onClick={() => void downloadCopy()}>
          <Download size={16} /> Keep a copy
        </Button>
      </Card>
    );
  } else if (phase === 'declined') {
    body = (
      <Card icon={<FileSignature size={28} />} title="You declined to sign">
        <p>{info?.sender.name ?? 'The sender'} has been told.</p>
      </Card>
    );
  } else if (phase === 'error') {
    body = (
      <Card icon={<TriangleAlert size={28} />} title="This link can't be opened">
        <p>{error}</p>
      </Card>
    );
  } else {
    body = statusCard(info);
  }
  return (
    <div className="app link-app">
      <Brand title={info?.title} />
      {body}
      {extras}
    </div>
  );
}
