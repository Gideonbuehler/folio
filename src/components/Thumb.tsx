import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Obj, PageItem } from '../types';
import { useStore } from '../store';
import { displaySize } from '../lib/geometry';
import { thumbnail } from '../lib/thumbs';
import { getLive, pageLiveKeys } from '../lib/live';
import { StaticObjects } from './objects';

const NO_HOLES = new Set<string>();

/** A lazily rendered page preview with the page's edits drawn on top. */
export const Thumb = memo(function Thumb({ page, width, objects }: { page: PageItem; width: number; objects: Obj[] }) {
  const doc = useStore((s) => s.docs[page.src]);
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [state, setState] = useState<{ url: string; native: Set<string> } | null>(null);
  const liveKey = useMemo(() => pageLiveKeys(objects, NO_HOLES).key, [objects]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || !doc) return;
    let alive = true;
    // Pages with Edit-mode changes preview the edited content, like the main view.
    const t = setTimeout(
      async () => {
        try {
          if (liveKey) {
            const live = await getLive(doc, page, objects, NO_HOLES);
            const url = await thumbnail(doc, page, width, { page: live.page, key: live.key });
            if (alive) setState({ url, native: live.native });
          } else {
            const url = await thumbnail(doc, page, width);
            if (alive) setState({ url, native: new Set() });
          }
        } catch {
          /* keep the previous preview */
        }
      },
      liveKey ? 300 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Re-render only when the content edits change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, doc, page, width, liveKey]);

  const d = displaySize(page, 1);
  const h = (width * d.h) / d.w;
  return (
    <div ref={ref} className="thumb-img" style={{ width, height: h }}>
      {state ? <img src={state.url} alt="" draggable={false} /> : <div className="thumb-skeleton" />}
      <StaticObjects page={page} objects={objects} zoom={width / d.w} native={state?.native} />
    </div>
  );
});
