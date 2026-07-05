import { useEffect, useRef, useState } from 'react';

// 画布组件。
// - canDraw=true(画手):可自由绘制,每段线通过 onStroke 上报;并显示工具条。
// - canDraw=false(猜者):只读,通过 ref 接收远端笔画实时重绘。
// 笔画格式:{ from:{x,y}, to:{x,y}, color, size }  坐标为 0..1 归一化(适配不同屏幕)。

const COLORS = ['#111827', '#ff6b6b', '#ffb547', '#3ecf8e', '#6c7dfc', '#e879f9', '#8b5e3c', '#ffffff'];
const SIZES = [3, 6, 12, 22];

const DrawCanvas = ({ canDraw, onStroke, onClear, strokeApiRef }) => {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [color, setColor] = useState('#111827');
  const [size, setSize] = useState(6);
  const colorRef = useRef(color);
  const sizeRef = useRef(size);
  colorRef.current = color; sizeRef.current = size;

  // 在 canvas 上画一段线(坐标归一化 0..1)
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

  // 暴露给父组件:远端笔画/清空 + 批量重绘(用于中途加入补画)
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
  // 批量缓冲:本地立即画(流畅),笔画攒进 buffer 每 ~60ms 发一批,大幅减少消息数(降延迟)
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
    drawSeg(stroke.from, stroke.to, stroke.color, stroke.size); // 本地即时绘制
    queueStroke(stroke);                                         // 批量上报
    last.current = cur;
  };
  const end = () => { drawing.current = false; last.current = null; flush(); }; // 抬笔立即冲刷

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
            onClick={() => { clearCanvas(); onClear?.(); }}>清空</button>
        </div>
      )}
    </div>
  );
};

export default DrawCanvas;
