import type { CSSProperties } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { Obj, PageItem, TextObj } from '../types';
import { arrowHead, cropRect, markupQuads, NOTE_SIZE, rotationMatrix } from '../lib/geometry';
import { FONT_CSS, layoutText, LINE_HEIGHT, measureText, TEXT_PAD } from '../lib/fonts';

export function inkPath(s: number[]) {
  const n = s.length / 2;
  if (n === 1) return `M${s[0]} ${s[1]}l0.01 0`;
  let d = `M${s[0]} ${s[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (s[i * 2] + s[i * 2 + 2]) / 2;
    const my = (s[i * 2 + 1] + s[i * 2 + 3]) / 2;
    d += `Q${s[i * 2]} ${s[i * 2 + 1]} ${mx} ${my}`;
  }
  return `${d}L${s[(n - 1) * 2]} ${s[(n - 1) * 2 + 1]}`;
}

export const svgTransform = (p: PageItem) => `matrix(${rotationMatrix(p).join(' ')})`;

export function cssTransform(p: PageItem, zoom: number) {
  const [a, b, c, d, e, f] = rotationMatrix(p);
  return `matrix(${a}, ${b}, ${c}, ${d}, ${e * zoom}, ${f * zoom})`;
}

/** Vector objects painted below text: whiteouts, covers, shapes, ink, images. */
export function BaseShape({ o }: { o: Obj }) {
  const common = { 'data-id': o.id, opacity: o.opacity < 1 ? o.opacity : undefined };
  switch (o.type) {
    case 'whiteout':
      return <rect {...common} className="hit-fill" x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color} />;
    case 'rect':
    case 'ellipse': {
      const shape = (p: { fill: string; stroke: string; strokeWidth: number }) =>
        o.type === 'rect' ? (
          <rect x={o.x} y={o.y} width={o.w} height={o.h} {...p} />
        ) : (
          <ellipse cx={o.x + o.w / 2} cy={o.y + o.h / 2} rx={Math.abs(o.w / 2)} ry={Math.abs(o.h / 2)} {...p} />
        );
      return (
        <g {...common} className="hit-fill">
          {!o.fill && shape({ fill: 'none', stroke: 'transparent', strokeWidth: Math.max(o.width, 10) })}
          {shape({ fill: o.fill ?? 'none', stroke: o.stroke ?? 'none', strokeWidth: o.width })}
        </g>
      );
    }
    case 'line':
      return (
        <g {...common} className="hit-stroke">
          <line x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke="transparent" strokeWidth={Math.max(o.width, 10)} strokeLinecap="round" />
          <line x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke={o.stroke} strokeWidth={o.width} strokeLinecap="round" />
        </g>
      );
    case 'arrow': {
      const h = arrowHead(o.x1, o.y1, o.x2, o.y2, o.width);
      return (
        <g {...common} className="hit-stroke">
          <line x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke="transparent" strokeWidth={Math.max(o.width, 10)} />
          <line x1={o.x1} y1={o.y1} x2={h.base.x} y2={h.base.y} stroke={o.stroke} strokeWidth={o.width} strokeLinecap="round" />
          <polygon points={`${o.x2},${o.y2} ${h.l.x},${h.l.y} ${h.r.x},${h.r.y}`} fill={o.stroke} />
        </g>
      );
    }
    case 'ink':
      return (
        <g {...common} className="hit-stroke" fill="none" strokeLinecap="round" strokeLinejoin="round">
          {o.strokes.map((s, i) => (
            <path key={`h${i}`} d={inkPath(s)} stroke="transparent" strokeWidth={Math.max(o.width, 10)} />
          ))}
          {o.strokes.map((s, i) => (
            <path key={i} d={inkPath(s)} stroke={o.stroke} strokeWidth={o.width} />
          ))}
        </g>
      );
    case 'image': {
      const img = <image {...common} className="hit-fill" href={o.src} x={o.x} y={o.y} width={o.w} height={o.h} preserveAspectRatio="none" />;
      if (!o.crop) return img;
      // A nested viewport clips the image to the part the PDF shows.
      const v = cropRect(o, o.crop);
      return (
        <svg x={v.x} y={v.y} width={v.w} height={v.h} viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`} overflow="hidden">
          {img}
        </svg>
      );
    }
    default:
      return null;
  }
}

/** Hides original page content that an edited object replaces. */
export function CoverShape({ o }: { o: Obj }) {
  if ((o.type !== 'text' && o.type !== 'image') || !o.cover) return null;
  const c = o.cover;
  return <rect x={c.x} y={c.y} width={c.w} height={c.h} fill={c.color} />;
}

/** Highlights; drawn in a multiply-blended layer so text stays legible. */
export function HighlightShape({ o }: { o: Obj }) {
  if (o.type !== 'highlight') return null;
  return (
    <g data-id={o.id} className="hit-fill" fill={o.color} opacity={o.opacity}>
      {o.rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />
      ))}
    </g>
  );
}

/** Underline, strikethrough and pending redactions sit above everything. */
export function TopShape({ o, preview, patch }: { o: Obj; preview?: boolean; patch?: string | null }) {
  if (o.type === 'underline' || o.type === 'strike') {
    return (
      <g data-id={o.id} className="hit-fill" opacity={o.opacity}>
        {o.rects.map((r, i) => (
          <rect key={`h${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
        ))}
        {markupQuads(o).map((q, i) => (
          <rect key={i} x={q.x} y={q.y} width={q.w} height={q.h} fill={o.color} />
        ))}
      </g>
    );
  }
  if (o.type === 'redact') {
    // Shown as it will look once saved; a dashed outline marks it as a redaction.
    const fillEl =
      o.match && patch ? (
        <image href={patch} x={o.x} y={o.y} width={o.w} height={o.h} preserveAspectRatio="none" />
      ) : (
        <rect x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color} />
      );
    if (preview) return fillEl;
    return (
      <g data-id={o.id} className="hit-fill redact-mark">
        <g className="redact-fill">{fillEl}</g>
        <rect className="redact-outline" x={o.x} y={o.y} width={o.w} height={o.h} />
      </g>
    );
  }
  return null;
}

export function textStyle(o: TextObj, zoom: number): CSSProperties {
  const box = measureText(o);
  const hs = o.hscale ?? 1;
  const transform = [o.rotate ? `rotate(${o.rotate}deg)` : '', hs !== 1 ? `scaleX(${hs})` : ''].join(' ').trim();
  return {
    left: o.x * zoom,
    top: o.y * zoom,
    // Laid out unscaled, then squeezed to the box width.
    width: (box.w / hs) * zoom,
    height: box.h * zoom,
    padding: `${TEXT_PAD * zoom}px ${(TEXT_PAD * zoom) / hs}px`,
    fontFamily: FONT_CSS[o.font],
    fontSize: o.size * zoom,
    fontWeight: o.bold ? 700 : 400,
    fontStyle: o.italic ? 'italic' : 'normal',
    lineHeight: o.lineHeight ?? LINE_HEIGHT,
    color: o.color,
    opacity: o.opacity < 1 ? o.opacity : undefined,
    transform: transform || undefined,
    transformOrigin: o.rotate ? 'center' : '0 0',
  };
}

export function TextView({ o, zoom }: { o: TextObj; zoom: number }) {
  return (
    <div className="tobj" data-id={o.id} style={textStyle(o, zoom)}>
      {layoutText(o)
        .map((l) => l.text)
        .join('\n') || '​'}
    </div>
  );
}

export function NoteView({ o, zoom, active }: { o: Obj & { type: 'note' }; zoom: number; active?: boolean }) {
  const s = NOTE_SIZE * zoom;
  return (
    <div
      className={`note-icon ${active ? 'active' : ''}`}
      data-id={o.id}
      style={{ left: o.x * zoom, top: o.y * zoom, width: s, height: s, '--note': o.color } as CSSProperties}
    >
      <MessageSquareText size={s * 0.68} strokeWidth={2.2} />
    </div>
  );
}

/** Non-interactive rendering of a page's objects (thumbnails, organizer). */
export function StaticObjects({ page, objects, zoom, native }: { page: PageItem; objects: Obj[]; zoom: number; native?: Set<string> }) {
  if (!objects.length) return null;
  const view = page.rotation % 180 ? `0 0 ${page.h} ${page.w}` : `0 0 ${page.w} ${page.h}`;
  const tx = svgTransform(page);
  // Edits already applied to the rendered page content need no patch or copy.
  const inPage = (o: Obj) => !!native?.has(o.id);
  return (
    <div className="static-objects">
      <svg viewBox={view} preserveAspectRatio="none">
        <g transform={tx}>
          {objects.map((o) =>
            inPage(o) ? null : o.type === 'whiteout' ? <BaseShape key={o.id} o={o} /> : <CoverShape key={o.id} o={o} />,
          )}
          {objects.map((o) => (o.type !== 'whiteout' && !(o.type === 'image' && inPage(o)) ? <BaseShape key={o.id} o={o} /> : null))}
        </g>
      </svg>
      <div className="ov-html" style={{ transform: cssTransform(page, zoom), width: page.w * zoom, height: page.h * zoom }}>
        {objects.map((o) =>
          o.type === 'text' ? <TextView key={o.id} o={o} zoom={zoom} /> : o.type === 'note' ? <NoteView key={o.id} o={o} zoom={zoom} /> : null,
        )}
      </div>
      <svg viewBox={view} preserveAspectRatio="none" className="blend">
        <g transform={tx}>
          {objects.map((o) => (
            <HighlightShape key={o.id} o={o} />
          ))}
        </g>
      </svg>
      <svg viewBox={view} preserveAspectRatio="none">
        <g transform={tx}>
          {objects.map((o) => (
            <TopShape key={o.id} o={o} preview />
          ))}
        </g>
      </svg>
    </div>
  );
}
