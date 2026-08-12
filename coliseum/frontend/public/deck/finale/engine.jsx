// engine.jsx — master clock, timeline, HUD, scaling, transitions, helpers

const { useState, useEffect, useRef, useCallback, createContext, useContext } = React;

// ── TIMELINE (seconds). Nudge these freely; total must stay under 180 (3 min). ──
const TIMELINE = [
  { id: 1, name: "HOOK",          dur: 17 },
  { id: 2, name: "THE INSIGHT",   dur: 23 },
  { id: 3, name: "THE LOOP",      dur: 26 },
  { id: 4, name: "PROOF",         dur: 13 },
  { id: 5, name: "ARCHITECTURE",  dur: 18 },
  { id: 6, name: "THE AGENTS",    dur: 24 },
  { id: 7, name: "WHY ONLY SOMNIA", dur: 13 },
  { id: 8, name: "TRACTION",      dur: 20 },
];
// cumulative starts
let _acc = 0;
TIMELINE.forEach(s => { s.start = _acc; _acc += s.dur; });
const TOTAL = _acc; // 154 (2:34)

function sceneIndexAt(t) {
  for (let i = TIMELINE.length - 1; i >= 0; i--) if (t >= TIMELINE[i].start) return i;
  return 0;
}

const REDUCED = typeof window !== "undefined" &&
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Clock context ──
const ClockCtx = createContext({ t: 0, playing: true, scene: 0, local: 0 });
const useClock = () => useContext(ClockCtx);

function fmtClock(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ── Reveal helper: progress 0..1 over [at, at+dur] of scene-local time ──
function prog(local, at, dur = 0.6) {
  if (REDUCED) return local >= at ? 1 : 0;
  if (dur <= 0) return local >= at ? 1 : 0;
  return Math.max(0, Math.min(1, (local - at) / dur));
}
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeOutBack = (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };

// <Rise> — fade + translate up as scene-local time passes `at`
function Rise({ at = 0, dur = 0.6, y = 28, from = "up", children, style = {}, className = "", glow = false, ...rest }) {
  const { local } = useClock();
  const p = easeOut(prog(local, at, dur));
  const off = (1 - p) * y;
  const tf = from === "up" ? `translateY(${off}px)`
    : from === "down" ? `translateY(${-off}px)`
    : from === "left" ? `translateX(${-off * 1.5}px)`
    : from === "right" ? `translateX(${off * 1.5}px)`
    : "none";
  // Respect a base opacity passed via style (e.g. a faded backdrop) by multiplying,
  // and never let style.transform silently clobber the reveal transform.
  const { opacity: baseOp = 1, transform: _ignore, ...restStyle } = style;
  return (
    <div className={className} style={{
      opacity: p * baseOp, transform: tf,
      ...(glow ? { filter: `drop-shadow(0 0 ${p * 18}px currentColor)` } : {}),
      ...restStyle,
    }} {...rest}>{children}</div>
  );
}

// <Ticker> — count up a number from 0→value over a window
function Ticker({ value, at = 0, dur = 1.2, decimals = 0, prefix = "", suffix = "", className = "", style = {} }) {
  const { local } = useClock();
  const p = easeOut(prog(local, at, dur));
  const v = value * p;
  const txt = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString();
  return <span className={`tnum ${className}`} style={style}>{prefix}{txt}{suffix}</span>;
}

// <TypeLine> — monospace typewriter keyed to scene-local time
function TypeLine({ text, at = 0, cps = 26, className = "", style = {}, cursor = true }) {
  const { local } = useClock();
  const elapsed = Math.max(0, local - at);
  const n = REDUCED ? text.length : Math.min(text.length, Math.floor(elapsed * cps));
  const done = n >= text.length;
  const started = local >= at;
  return (
    <span className={className} style={style}>
      {started ? text.slice(0, n) : ""}
      {cursor && started && !done && <span style={{ opacity: Math.floor(elapsed * 2) % 2 ? 0.2 : 1 }}>▮</span>}
    </span>
  );
}

// ── Asset slot: dashed placeholder OR the real image if `src` provided ──
function AssetSlot({ src, label, style = {}, className = "" }) {
  return (
    <div className={`asset-slot ${className}`} style={style}>
      {src
        ? <img src={src} alt={label} />
        : <span>▸ ASSET<br />{label}</span>}
    </div>
  );
}

// ── Somnia brand mark (SOMI coin) + wordmark. Source PNGs are dark on a
//    transparent bg, so we invert them to a crisp white token/wordmark that
//    reads on the near-black stage. ──
function SomniaMark({ size = 28, style = {} }) {
  return <img src={window.SOMI_ICON_URI} alt="Somnia" style={{ width: size, height: size, display: "inline-block", verticalAlign: "middle", filter: "invert(1)", ...style }} />;
}

// ── HUD ──
function Hud({ t, sceneIdx }) {
  const scene = TIMELINE[sceneIdx];
  const pct = Math.min(100, (t / TOTAL) * 100);
  return (
    <div className="hud">
      <div className="hud-corner tl" /><div className="hud-corner tr" />
      <div className="hud-corner bl" /><div className="hud-corner br" />
      <div className="hud-top">
        <span className="hud-rec"><span className="rec-dot" /> REC</span>
        <span>RD {String(scene.id).padStart(2, "0")} / {String(TIMELINE.length).padStart(2, "0")} · {scene.name}</span>
        <span className="tnum">{fmtClock(t)} / {fmtClock(TOTAL)}</span>
      </div>
      <div className="hud-bottom">
        <span className="tnum">{fmtClock(t)}</span>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: pct + "%" }} />
          <div className="progress-ticks">
            {TIMELINE.map(s => <span key={s.id} style={{ flexGrow: s.dur }} />)}
          </div>
        </div>
        <span>COLISEUM · FINALE</span>
      </div>
    </div>
  );
}

// ── Root deck: owns the clock, scaling, keyboard, transitions ──
function Deck({ scenes }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [scale, setScale] = useState(1);
  const [wipeKey, setWipeKey] = useState(0);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const tRef = useRef(0);
  const prevSceneRef = useRef(0);

  // resolve current scene index from t
  const sceneIdx = sceneIndexAt(t);
  const local = t - TIMELINE[sceneIdx].start;

  // trigger a signal-wipe whenever the scene index changes
  useEffect(() => {
    if (prevSceneRef.current !== sceneIdx) {
      prevSceneRef.current = sceneIdx;
      if (!REDUCED) setWipeKey(k => k + 1);
    }
  }, [sceneIdx]);

  // clock — driven by rAF (smooth, foreground) with a setInterval fallback
  // (keeps advancing when the tab is backgrounded / rAF is throttled).
  useEffect(() => {
    lastRef.current = 0; // re-sync on (re)subscribe so pause/resume never jumps
    const advance = (now) => {
      if (lastRef.current === 0) lastRef.current = now;
      let dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      if (dt < 0) dt = 0;
      if (dt > 1.5) dt = 1.5; // cap big gaps from throttling
      if (playing) {
        // Per-page mode: play the current scene's animation, then HOLD on its
        // last frame. Only ArrowRight advances to the next scene.
        const i = sceneIndexAt(tRef.current);
        const sceneEnd = TIMELINE[i].start + TIMELINE[i].dur - 0.001;
        let nt = Math.min(sceneEnd, tRef.current + dt);
        tRef.current = nt;
        setT(nt);
      }
    };
    const raf = () => { advance(performance.now()); rafRef.current = requestAnimationFrame(raf); };
    rafRef.current = requestAnimationFrame(raf);
    const iv = setInterval(() => advance(performance.now()), 200);
    return () => { cancelAnimationFrame(rafRef.current); clearInterval(iv); };
  }, [playing]);

  const jumpTo = useCallback((nt) => {
    nt = Math.max(0, Math.min(TOTAL, nt));
    tRef.current = nt; setT(nt);
  }, []);

  // scaling to fit viewport — robust against 0-dimension first layout in iframes
  const wrapRef = useRef(null);
  useEffect(() => {
    const fit = () => {
      const w = (wrapRef.current && wrapRef.current.clientWidth) || window.innerWidth;
      const h = (wrapRef.current && wrapRef.current.clientHeight) || window.innerHeight;
      if (w > 0 && h > 0) setScale(Math.min(w / 1920, h / 1080)); // never lock to 0
    };
    fit();
    requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); }); // after layout settles
    window.addEventListener("resize", fit);
    let ro;
    if (window.ResizeObserver && wrapRef.current) {
      ro = new ResizeObserver(fit);
      ro.observe(wrapRef.current);
    }
    return () => { window.removeEventListener("resize", fit); if (ro) ro.disconnect(); };
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === "ArrowRight") {
        const i = sceneIndexAt(tRef.current);
        jumpTo(i >= TIMELINE.length - 1 ? TOTAL - 0.001 : TIMELINE[i + 1].start);
      }
      else if (e.key === "ArrowLeft") {
        // go to start of current scene, or previous if near start
        let i = 0; for (let k = TIMELINE.length - 1; k >= 0; k--) if (tRef.current >= TIMELINE[k].start) { i = k; break; }
        const target = (tRef.current - TIMELINE[i].start < 1 && i > 0) ? TIMELINE[i - 1].start : TIMELINE[i].start;
        jumpTo(target);
      }
      else if (e.key.toLowerCase() === "r") { jumpTo(0); setPlaying(true); }
      else if (e.key.toLowerCase() === "f") {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpTo]);

  const SceneComp = scenes[sceneIdx];

  return (
    <ClockCtx.Provider value={{ t, playing, scene: sceneIdx, local }}>
      <div className="stage-wrap" ref={wrapRef}>
        <div className="stage" style={{ transform: `scale(${scale})` }}>
          {/* ambient */}
          <div className="bg-glow" />
          <div className="bg-grid" />

          {/* current scene */}
          <div className="scene" key={sceneIdx}>
            <SceneComp local={local} />
          </div>

          {/* scanline + vignette above content, below HUD */}
          <div className="bg-scan" />
          <div className="bg-vignette" />

          {/* transitions */}
          {!REDUCED && <div className="wipe run" key={"w" + wipeKey} />}
          {!REDUCED && <div className="glitch-flash run" key={"g" + wipeKey} />}

          {/* HUD */}
          <Hud t={t} sceneIdx={sceneIdx} />

          {/* pause overlay hint */}
          {!playing && (
            <div style={{
              position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)", zIndex: 85,
              fontFamily: "var(--fnt-mono)", fontSize: 13, letterSpacing: "0.3em", color: "var(--amber)",
            }}>❚❚ PAUSED — SPACE TO RESUME</div>
          )}

          <div className="keys">
            <span><b>→</b> next page</span>
            <span><b>←</b> back</span>
            <span><b>SPACE</b> pause</span>
            <span><b>R</b> restart</span>
            <span><b>F</b> fullscreen</span>
          </div>
        </div>
      </div>
    </ClockCtx.Provider>
  );
}

Object.assign(window, {
  TIMELINE, TOTAL, REDUCED, useClock, fmtClock,
  prog, easeOut, easeOutBack, Rise, Ticker, TypeLine, AssetSlot, SomniaMark, Hud, Deck,
});
