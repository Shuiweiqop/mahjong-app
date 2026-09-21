import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n.jsx';

// Canvas component.
// - canDraw=true (the drawer): free drawing; every segment is reported through
//   onStroke, and the toolbar is shown.
// - canDraw=false (the guessers): read-only, redrawing remote strokes in real time
//   through the ref.
// Stroke format: { from:{x,y}, to:{x,y}, color, size }, with coordinates normalised
// to 0..1 so they map correctly onto any screen size.

const COLORS = ['#111827', '#ff6b6b', '#ffb547', '#3ecf8e', '#6c7dfc', '#e879f9', '#8b5e3c', '#ffffff'];
const SIZES = [3, 6, 12, 22];

const DrawCanvas = ({ canDraw, onStroke, onClear, strokeApiRef }) => {
  const t = useT();
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [color, setColor] = useState('#111827');
  const [size, setSize] = useState(6);
  const colorRef = useRef(color);
  const sizeRef = useRef(size);
  colorRef.current = color; sizeRef.current = size;

  // Draw one segment on the canvas (coordinates normalised to 0..1)
  const drawSeg = (from, to, col, sz) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = col;
    ctx.lineWidth = sz;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x * cv.width, from.y * cv.height);
    ctx.lineTo(to.x * cv.width, to.y * cv.height);
    ctx.stroke();
  };

  const clearCanvas = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  };

  // Exposed to the parent: remote strokes, clear, and a bulk redraw (used to catch up
  // a player who joined mid-round)
  useEffect(() => {
    if (!strokeApiRef) return;
    strokeApiRef.current = {
      applyRemoteStroke: (s) => drawSeg(s.from, s.to, s.color, s.size),
      clear: clearCanvas,
      redrawAll: (strokes) => {
        clearCanvas();
        (strokes || []).forEach((s) => drawSeg(s.from, s.to, s.color, s.size));
      },
    };
  }, [strokeApiRef]);

  const pos = (e) => {
    const cv = canvasRef.current;
    const rect = cv.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - rect.left) / rect.width, y: (p.clientY - rect.top) / rect.height };
  };

  const start = (e) => { if (!canDraw) return; drawing.current = true; last.current = pos(e); };
  // Batching buffer: draw locally straight away so it stays smooth, while strokes
  // accumulate and ship roughly every 60ms. That cuts the message count sharply, which
  // keeps latency down.
  const buffer = useRef([]);
  const flushTimer = useRef(null);
  const flush = () => {
    if (buffer.current.length) { onStroke?.(buffer.current); buffer.current = []; }
    flushTimer.current = null;
  };
  const queueStroke = (stroke) => {
    buffer.current.push(stroke);
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
  };

  const move = (e) => {
    if (!canDraw || !drawing.current) return;
    e.preventDefault();
    const cur = pos(e);
    const stroke = { from: last.current, to: cur, color: colorRef.current, size: sizeRef.current };
    drawSeg(stroke.from, stroke.to, stroke.color, stroke.size); // draw locally, immediately
    queueStroke(stroke);                                         // report in batches
    last.current = cur;
  };
  const end = () => { drawing.current = false; last.current = null; flush(); }; // flush as soon as the pen lifts

  return (
    <div>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#fff', borderRadius: 12, overflow: 'hidden', border: '2px solid var(--border)' }}>
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          style={{ width: '100%', height: '100%', touchAction: 'none', cursor: canDraw ? 'crosshair' : 'default' }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        />
      </div>

      {canDraw && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} title={c}
              style={{ width: 26, height: 26, borderRadius: '50%', background: c, cursor: 'pointer',
                border: color === c ? '3px solid var(--primary-light)' : '2px solid var(--border)' }} />
          ))}
          <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
          {SIZES.map((sz) => (
            <button key={sz} onClick={() => setSize(sz)}
              style={{ width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center',
                background: size === sz ? 'var(--primary)' : 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <span style={{ width: sz, height: sz, borderRadius: '50%', background: size === sz ? '#fff' : 'var(--muted)' }} />
            </button>
          ))}
          <button style={{ marginLeft: 'auto', background: 'var(--surface-2)', color: 'var(--danger)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 700 }}
            onClick={() => { clearCanvas(); onClear?.(); }}>{t('draw.canvasClear')}</button>
        </div>
      )}
    </div>
  );
};

export default DrawCanvas;
