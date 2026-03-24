import { useState, useRef, useEffect, useCallback } from "react";
import { GARMENTS, MEASUREMENT_LABELS } from "./garments.js";
import { scorePose, drawSkeleton } from "./poseQuality.js";
import { speak, stopSpeaking, setLang, getLang } from "./voice.js";
import {
  geminiEnabled, frameToBase64,
  checkClothing, verifyAngle, extractMeasurements, getPoseGuidance,
} from "./gemini.js";

// ─── Constants (declared ONCE at top) ────────────────────────────────────────
const MIN_POSE_SCORE     = 76;
const GOOD_FRAMES_NEEDED = 50;
const GUIDE_INTERVAL_MS  = 5000;

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:"#0a0a0a", surface:"#121212", card:"#1a1a1a",
  border:"#242424", gold:"#FFD700", amber:"#FFA726",
  green:"#66BB6A", red:"#EF5350", text:"#f0f0f0", muted:"#686868",
};
const S = {
  page:  { maxWidth:480, margin:"0 auto", padding:"20px 16px 56px", display:"flex", flexDirection:"column", gap:14, minHeight:"100vh", animation:"fadeUp 0.3s ease" },
  card:  { background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:16 },
  btn:   { background:C.gold, color:"#111", border:"none", borderRadius:12, padding:"15px 20px", fontSize:16, fontWeight:700, cursor:"pointer", width:"100%", transition:"all 0.2s" },
  btn2:  { background:C.card, color:C.text, border:`1px solid ${C.border}`, borderRadius:12, padding:"13px 20px", fontSize:15, fontWeight:600, cursor:"pointer" },
  back:  { background:"none", border:"none", color:C.muted, fontSize:14, cursor:"pointer", alignSelf:"flex-start", padding:"4px 0" },
  label: { fontSize:11, fontWeight:700, color:C.muted, letterSpacing:"0.1em", textTransform:"uppercase", display:"block", marginBottom:8 },
  hint:  { fontSize:12, color:C.muted, marginTop:6, lineHeight:1.5 },
};

// Scan angle sequence
const ANGLES = [
  { key:"front", label:"Front",      nudge:"Face the camera directly" },
  { key:"right", label:"Right Side", nudge:"Turn your RIGHT side to the camera" },
  { key:"back",  label:"Back",       nudge:"Turn your BACK to the camera" },
  { key:"left",  label:"Left Side",  nudge:"Turn your LEFT side to the camera" },
];

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const poseRef     = useRef(null);
  const cameraRef   = useRef(null);
  const streamRef   = useRef(null);
  const goodFrames  = useRef(0);
  const capturedPhotos    = useRef({});
  const lastGuideTime     = useRef(0);
  const lastGuideIssue    = useRef('');
  const isVerifying       = useRef(false);
  const angleIdxRef       = useRef(0); // mirror of state for use inside callbacks

  const [screen,          setScreen]        = useState("home");
  const [lang,            setLangState]     = useState("en");
  const [garment,         setGarment]       = useState(null);
  const [height,          setHeight]        = useState("");
  const [gender,          setGender]        = useState("female");
  const [facingMode,      setFacingMode]    = useState("user");
  const [mpLoaded,        setMpLoaded]      = useState(false);
  const [angleIdx,        setAngleIdx]      = useState(0);
  const [poseScore,       setPoseScore]     = useState(0);
  const [guidance,        setGuidance]      = useState("Starting camera...");
  const [fillPct,         setFillPct]       = useState(0);
  const [phaseLabel,      setPhaseLabel]    = useState("");
  const [measurements,    setMeasurements]  = useState(null);
  const [aiAnalysis,      setAiAnalysis]    = useState("");
  const [confidence,      setConfidence]    = useState({});
  const [isProcessing,    setIsProcessing]  = useState(false);
  const [clothingOk,      setClothingOk]    = useState(false);
  const [checkingClothing,setCheckingClothing] = useState(false);
  const [hasConcern,      setHasConcern]    = useState(false);

  // Keep ref in sync with state for use in callbacks
  useEffect(() => { angleIdxRef.current = angleIdx; }, [angleIdx]);

  // Poll for MediaPipe
  useEffect(() => {
    const t = setInterval(() => { if (window.Pose) { setMpLoaded(true); clearInterval(t); } }, 300);
    return () => clearInterval(t);
  }, []);

  const switchLang = (l) => { setLangState(l); setLang(l); };

  // ── Camera start ─────────────────────────────────────────────────────────
  const startCamera = useCallback(async (facing, onReadyCb) => {
    const f = facing || facingMode;
    cameraRef.current?.stop?.();
    poseRef.current?.close?.();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());

    const pose = new window.Pose({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });
    pose.setOptions({
      modelComplexity:1, smoothLandmarks:true, enableSegmentation:false,
      minDetectionConfidence:0.62, minTrackingConfidence:0.62,
    });

    pose.onResults(results => {
      const canvas = canvasRef.current;
      const video  = videoRef.current;
      if (!canvas || !video) return;

      const ctx = canvas.getContext("2d");
      const W = canvas.width  = video.videoWidth  || 640;
      const H = canvas.height = video.videoHeight || 480;

      ctx.save();
      if (f === "user") { ctx.scale(-1,1); ctx.drawImage(results.image, -W, 0, W, H); }
      else ctx.drawImage(results.image, 0, 0, W, H);
      ctx.restore();

      const lm = results.poseLandmarks;
      if (!lm) {
        goodFrames.current = 0;
        setPoseScore(0); setFillPct(0);
        setGuidance("Step in front of the camera");
        return;
      }

      drawSkeleton(ctx, lm, W, H, f === "user");

      const currentAngle = ANGLES[angleIdxRef.current]?.key || 'front';
      const { score, ready } = scorePose(lm, W, H, currentAngle);
      setPoseScore(score);

      if (ready && !isVerifying.current && !isProcessing) {
        goodFrames.current++;
        const pct = Math.min(100, Math.round(goodFrames.current / GOOD_FRAMES_NEEDED * 100));
        setFillPct(pct);
        if (goodFrames.current === 10)  setGuidance("Good position — hold still...");
        if (goodFrames.current === 30)  setGuidance("Almost there, keep steady...");
        if (goodFrames.current >= GOOD_FRAMES_NEEDED) {
          handleAutoCapture(canvas, currentAngle);
        }
      } else {
        goodFrames.current = Math.max(0, goodFrames.current - 3);
        setFillPct(Math.max(0, Math.round(goodFrames.current / GOOD_FRAMES_NEEDED * 100)));
        const now = Date.now();
        if (now - lastGuideTime.current > GUIDE_INTERVAL_MS && !isVerifying.current) {
          lastGuideTime.current = now;
          requestGeminiGuidance(canvas, currentAngle);
        }
      }
    });

    poseRef.current = pose;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, width:{ ideal:640 }, height:{ ideal:480 } },
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await new Promise(res => { videoRef.current.onloadedmetadata = res; });
      videoRef.current.play();
      const cam = new window.Camera(videoRef.current, {
        onFrame: async () => { await pose.send({ image: videoRef.current }); },
        width:640, height:480,
      });
      cam.start();
      cameraRef.current = cam;
      if (onReadyCb) onReadyCb();
    } catch {
      setGuidance("Camera access denied. Please allow camera and refresh.");
    }
  }, [facingMode, isProcessing]);

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop?.();
    poseRef.current?.close?.();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, []);

  // ── Gemini real-time guidance ─────────────────────────────────────────────
  const requestGeminiGuidance = async (canvas, angle) => {
    if (!geminiEnabled()) return;
    const b64 = frameToBase64(canvas);
    const msg = await getPoseGuidance(b64, angle, lastGuideIssue.current, getLang());
    if (msg) { setGuidance(msg); speak(msg, false); lastGuideIssue.current = msg; }
  };

  // ── Clothing check ────────────────────────────────────────────────────────
  const doClothingCheck = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !geminiEnabled()) { setClothingOk(true); startAngle(0); return; }
    setCheckingClothing(true);
    setGuidance("Checking your outfit...");
    const b64 = frameToBase64(canvas);
    const msg = await checkClothing(b64, getLang());
    setCheckingClothing(false);
    setGuidance(msg);
    speak(msg, true);
    const concernWords = ['change','loose','baggy','nighty','fitted','suggest','accuracy','മാറ്','ഫിറ്റ്','അഴിഞ്ഞ'];
    const concern = concernWords.some(w => msg.toLowerCase().includes(w.toLowerCase()));
    setHasConcern(concern);
    if (!concern) { setClothingOk(true); startAngle(0); }
  };

  // ── Start angle ───────────────────────────────────────────────────────────
  const startAngle = (idx) => {
    setAngleIdx(idx);
    angleIdxRef.current = idx;
    goodFrames.current = 0;
    setFillPct(0);
    isVerifying.current = false;
    lastGuideIssue.current = '';
    const angle = ANGLES[idx];
    const msg = idx === 0
      ? `Great! Let's start with the front view. ${angle.nudge}.`
      : `Now for your ${angle.label}. ${angle.nudge}.`;
    setGuidance(msg);
    speak(msg, true);
    setPhaseLabel(`${idx + 1} of 4 — ${angle.label}`);
  };

  // ── Auto-capture when pose steady enough ─────────────────────────────────
  const handleAutoCapture = async (canvas, angleKey) => {
    if (isVerifying.current) return;
    isVerifying.current = true;
    goodFrames.current = 0;
    setFillPct(100);
    setGuidance("Checking your position...");

    const b64 = frameToBase64(canvas);
    const result = await verifyAngle(b64, angleKey, getLang());

    if (result.verified && result.quality !== 'poor') {
      capturedPhotos.current[angleKey] = b64;
      const msg = result.message || `${angleKey} captured!`;
      setGuidance(msg);
      speak(msg, true);

      const nextIdx = ANGLES.findIndex(a => a.key === angleKey) + 1;
      setTimeout(() => {
        if (nextIdx < ANGLES.length) {
          isVerifying.current = false;
          setFillPct(0);
          startAngle(nextIdx);
        } else {
          finalizeMeasurements();
        }
      }, 1800);
    } else {
      isVerifying.current = false;
      setFillPct(0);
      const msg = result.message || "Let's try that again.";
      setGuidance(msg);
      speak(msg, true);
    }
  };

  // ── Finalize: send all photos to Gemini Pro ───────────────────────────────
  const finalizeMeasurements = async () => {
    stopCamera();
    setIsProcessing(true);
    setScreen("processing");
    speak("I have all four photos. Analysing your measurements now — this takes about 15 seconds.", true);

    const photos = ANGLES.map(a => capturedPhotos.current[a.key] || null);
    const g      = GARMENTS[garment];
    const result = await extractMeasurements(
      photos, g.label, g.geminiContext,
      parseFloat(height) || 165, getLang(), gender
    );

    setMeasurements(result.measurements || {});
    setAiAnalysis(result.analysis || "Measurements complete.");
    setConfidence(result.confidence || {});
    setIsProcessing(false);
    setScreen("results");
    if (result.analysis) setTimeout(() => speak(result.analysis, true), 600);
  };

  // ── Camera swap ───────────────────────────────────────────────────────────
  const swapCamera = () => {
    const next = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
    goodFrames.current = 0; setFillPct(0);
    startCamera(next);
  };

  // ─── Screen router ────────────────────────────────────────────────────────
  return (
    <div style={{ background:C.bg, minHeight:"100vh" }}>
      {screen === "home"    && <HomeScreen lang={lang} switchLang={switchLang} setScreen={setScreen} />}
      {screen === "garment" && <GarmentScreen setScreen={setScreen} setGarment={setGarment} />}
      {screen === "setup"   && (
        <SetupScreen
          setScreen={setScreen} garment={garment}
          height={height} setHeight={setHeight}
          gender={gender} setGender={setGender}
          mpLoaded={mpLoaded}
          onStart={() => {
            capturedPhotos.current = {};
            setMeasurements(null); setAiAnalysis(""); setConfidence({});
            setAngleIdx(0); angleIdxRef.current = 0;
            goodFrames.current = 0; setClothingOk(false); setHasConcern(false);
            setScreen("scan");
            setTimeout(() => startCamera(facingMode, () => setTimeout(doClothingCheck, 2200)), 300);
          }}
        />
      )}
      {screen === "scan" && (
        <ScanScreen
          videoRef={videoRef} canvasRef={canvasRef}
          angleIdx={angleIdx} poseScore={poseScore}
          guidance={guidance} fillPct={fillPct} phaseLabel={phaseLabel}
          isVerifyingRef={isVerifying}
          checkingClothing={checkingClothing} clothingOk={clothingOk} hasConcern={hasConcern}
          facingMode={facingMode} swapCamera={swapCamera}
          capturedPhotos={capturedPhotos.current}
          onContinueAnyway={() => { setHasConcern(false); setClothingOk(true); startAngle(0); }}
          onBack={() => { stopCamera(); stopSpeaking(); setScreen("setup"); }}
        />
      )}
      {screen === "processing" && <ProcessingScreen />}
      {screen === "results"    && (
        <ResultsScreen
          measurements={measurements} garment={garment}
          aiAnalysis={aiAnalysis} confidence={confidence}
          onRemeasure={() => { capturedPhotos.current = {}; setMeasurements(null); setAiAnalysis(""); setScreen("garment"); }}
        />
      )}
    </div>
  );
}

// ─── HOME ─────────────────────────────────────────────────────────────────────
function HomeScreen({ lang, switchLang, setScreen }) {
  return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop:36 }}>
        <div style={{ fontSize:56, animation:"breathe 3s ease-in-out infinite" }}>🐝</div>
        <h1 style={{ fontSize:38, fontWeight:800, letterSpacing:"-1.5px", color:C.gold, margin:"10px 0 4px" }}>
          TailorBee
        </h1>
        <p style={{ fontSize:11, fontWeight:700, letterSpacing:"0.2em", textTransform:"uppercase", color:C.amber }}>
          AI Measurement System v4
        </p>
        <p style={{ fontSize:14, color:C.muted, marginTop:10, lineHeight:1.7, maxWidth:320, margin:"10px auto 0" }}>
          Gemini Vision analyses your body from 4 angles using Indian proportion data for accurate clothing measurements.
        </p>
      </div>

      <div style={S.card}>
        <span style={S.label}>🌐 Language / ഭാഷ</span>
        <div style={{ display:"flex", gap:10 }}>
          {[["en","English"],["ml","മലയാളം"]].map(([l, label]) => (
            <button key={l} onClick={() => switchLang(l)}
              style={{ flex:1, padding:"12px", borderRadius:10, cursor:"pointer", fontWeight:700, fontSize:14, transition:"all 0.2s",
                border:`2px solid ${lang===l ? C.gold : C.border}`,
                background: lang===l ? "#1a1400" : C.surface,
                color: lang===l ? C.gold : C.muted }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...S.card, display:"flex", gap:12, alignItems:"flex-start" }}>
        <span style={{ fontSize:22, marginTop:2 }}>{geminiEnabled() ? "✅" : "⚠️"}</span>
        <div>
          <p style={{ fontSize:14, fontWeight:700, color: geminiEnabled() ? C.green : C.amber, margin:0 }}>
            {geminiEnabled() ? "Gemini Vision active" : "Gemini key not configured"}
          </p>
          <p style={{ ...S.hint, marginTop:3 }}>
            {geminiEnabled()
              ? "Using Gemini Pro for measurements + Flash for real-time guidance."
              : "Add VITE_GEMINI_API_KEY to your .env file. The app won't measure without it."}
          </p>
        </div>
      </div>

      <div style={S.card}>
        <span style={S.label}>What's new in v4</span>
        {[
          "Gemini 1.5 Pro for measurements (more accurate vision model)",
          "Indian body proportion reference data baked into analysis",
          "Ramanujan ellipse formula for circumference (more accurate than basic π×d)",
          "Sanity check pass — catches obviously wrong measurements",
          "Gender-aware reference ranges",
          "Fallback to Flash if Pro unavailable",
        ].map((t, i) => (
          <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
            <span style={{ color:C.green, flexShrink:0, fontSize:13 }}>✓</span>
            <span style={{ fontSize:13, color:C.muted }}>{t}</span>
          </div>
        ))}
      </div>

      <button style={S.btn} onClick={() => setScreen("garment")}>Start Measuring →</button>
    </div>
  );
}

// ─── GARMENT ──────────────────────────────────────────────────────────────────
function GarmentScreen({ setScreen, setGarment }) {
  return (
    <div style={S.page}>
      <button style={S.back} onClick={() => setScreen("home")}>← Back</button>
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>Select Garment</h2>
      <p style={{ ...S.hint, margin:0 }}>Gemini knows exactly which measurements each garment needs.</p>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        {Object.entries(GARMENTS).map(([key, g]) => (
          <button key={key}
            style={{ ...S.card, display:"flex", flexDirection:"column", alignItems:"center",
              gap:5, cursor:"pointer", padding:"18px 10px", border:`1px solid ${C.border}`, transition:"border-color 0.2s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor=C.gold}
            onMouseLeave={e => e.currentTarget.style.borderColor=C.border}
            onClick={() => { setGarment(key); setScreen("setup"); }}>
            <span style={{ fontSize:30 }}>{g.emoji}</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.text, textAlign:"center" }}>{g.label}</span>
            <span style={{ fontSize:11, color:C.muted }}>{g.measurements.length} measurements</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function SetupScreen({ setScreen, garment, height, setHeight, gender, setGender, mpLoaded, onStart }) {
  const g = GARMENTS[garment];
  const canStart = mpLoaded && height && parseFloat(height) > 50 && parseFloat(height) < 250;

  return (
    <div style={S.page}>
      <button style={S.back} onClick={() => setScreen("garment")}>← Back</button>
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>Setup</h2>

      {/* Height */}
      <div style={S.card}>
        <span style={S.label}>📏 Height in cm — required for calibration</span>
        <input
          style={{ width:"100%", background:"#111", color:C.text, fontSize:24, fontWeight:800,
            border:`2px solid ${height ? C.gold : C.border}`, outline:"none", padding:"14px",
            textAlign:"center", borderRadius:10, transition:"border-color 0.2s" }}
          type="number" placeholder="e.g. 162" value={height}
          onChange={e => setHeight(e.target.value)}
        />
        <p style={S.hint}>Gemini uses this to calibrate pixel-to-cm. More accurate = more accurate results.</p>
      </div>

      {/* Gender */}
      <div style={S.card}>
        <span style={S.label}>👤 Body type — for proportion reference</span>
        <div style={{ display:"flex", gap:10 }}>
          {[["female","Female / Women's"],["male","Male / Men's"]].map(([v, label]) => (
            <button key={v} onClick={() => setGender(v)}
              style={{ flex:1, padding:"11px", borderRadius:10, cursor:"pointer", fontWeight:600, fontSize:13, transition:"all 0.2s",
                border:`2px solid ${gender===v ? C.gold : C.border}`,
                background: gender===v ? "#1a1400" : C.surface,
                color: gender===v ? C.gold : C.muted }}>
              {label}
            </button>
          ))}
        </div>
        <p style={S.hint}>Used to apply correct Indian body proportion ranges when checking measurements.</p>
      </div>

      {/* Measurements list */}
      <div style={S.card}>
        <span style={S.label}>Measurements for {g?.label}</span>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {g?.measurements.map(m => (
            <span key={m} style={{ background:"#111", border:`1px solid ${C.border}`,
              borderRadius:6, padding:"4px 10px", fontSize:12, color:C.muted }}>
              {MEASUREMENT_LABELS[m]}
            </span>
          ))}
        </div>
      </div>

      {/* Tips */}
      <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}33` }}>
        <span style={S.label}>💡 For best accuracy</span>
        {["Wear fitted t-shirt + leggings (Gemini will check and remind you)",
          "Stand 1.5–2 m from camera in good lighting",
          "Keep arms slightly away from your sides",
          "Stand on a flat floor, feet together"].map(t => (
          <p key={t} style={{ fontSize:13, color:C.muted, lineHeight:1.6, margin:"3px 0" }}>• {t}</p>
        ))}
      </div>

      {!mpLoaded && (
        <div style={{ textAlign:"center" }}>
          <div style={{ width:"100%", height:3, background:C.border, borderRadius:2, overflow:"hidden", marginBottom:8 }}>
            <div style={{ height:"100%", width:"60%", background:C.gold, animation:"pulse 1.2s ease-in-out infinite" }}/>
          </div>
          <p style={{ fontSize:13, color:C.muted }}>Loading AI pose engine...</p>
        </div>
      )}

      <button style={{ ...S.btn, opacity: canStart ? 1 : 0.45 }} disabled={!canStart} onClick={onStart}>
        {!mpLoaded ? "Loading..." : !height ? "Enter your height first" : "Start AI Scan →"}
      </button>
    </div>
  );
}

// ─── SCAN SCREEN ──────────────────────────────────────────────────────────────
function ScanScreen({ videoRef, canvasRef, angleIdx, poseScore, guidance, fillPct,
  phaseLabel, isVerifyingRef, checkingClothing, clothingOk, hasConcern,
  facingMode, swapCamera, capturedPhotos, onContinueAnyway, onBack }) {

  const angle      = ANGLES[angleIdx] || ANGLES[0];
  const scoreColor = poseScore >= MIN_POSE_SCORE ? C.green : poseScore >= 50 ? C.amber : C.red;
  const circ       = 2 * Math.PI * 44;
  const isVerifying = isVerifyingRef?.current || false;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:"#000" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", background:"rgba(0,0,0,0.92)", backdropFilter:"blur(12px)", zIndex:10 }}>
        <button style={{ background:"none", border:"none", color:"#fff", fontSize:20, cursor:"pointer" }} onClick={onBack}>✕</button>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {ANGLES.map((a, i) => {
            const done = !!capturedPhotos[a.key];
            return (
              <div key={a.key} style={{ width: i===angleIdx ? 28 : 8, height:8, borderRadius:4,
                background: done ? C.green : i===angleIdx ? C.gold : C.border,
                transition:"all 0.4s ease" }}/>
            );
          })}
        </div>
        <button onClick={swapCamera}
          style={{ background:"rgba(255,255,255,0.08)", border:`1px solid ${C.border}`,
            borderRadius:20, padding:"5px 12px", color:"#fff", fontSize:12, fontWeight:600, cursor:"pointer" }}>
          {facingMode === "user" ? "🔄 Rear" : "🔄 Front"}
        </button>
      </div>

      {/* Camera */}
      <div style={{ flex:1, position:"relative", overflow:"hidden", background:"#111" }}>
        <video ref={videoRef} style={{ position:"absolute", opacity:0, width:1, height:1, pointerEvents:"none" }}/>
        <canvas ref={canvasRef} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>

        {/* Scan line */}
        {clothingOk && !isVerifying && (
          <div style={{ position:"absolute", left:0, right:0, height:2, pointerEvents:"none",
            background:"linear-gradient(90deg, transparent, rgba(255,215,0,0.35), transparent)",
            animation:"scanDown 2.8s linear infinite" }}/>
        )}

        {/* Body outline ghost */}
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", opacity:0.1 }}
          viewBox="0 0 100 160" preserveAspectRatio="xMidYMid meet">
          <ellipse cx="50" cy="10" rx="7" ry="8" fill="none" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="18" x2="50" y2="72" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="27" y1="29" x2="73" y2="29" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="72" x2="37" y2="128" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="72" x2="63" y2="128" stroke={C.gold} strokeWidth="0.8"/>
        </svg>

        {/* Checking clothing overlay */}
        {checkingClothing && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.7)",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14 }}>
            <div style={{ width:44, height:44, border:`3px solid ${C.gold}33`,
              borderTop:`3px solid ${C.gold}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
            <p style={{ color:"#fff", fontSize:15, fontWeight:600 }}>Checking your outfit...</p>
          </div>
        )}

        {/* Verifying overlay */}
        {isVerifying && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.6)",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, animation:"popIn 0.3s ease" }}>
            <div style={{ width:44, height:44, border:`3px solid ${C.amber}33`,
              borderTop:`3px solid ${C.amber}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
            <p style={{ color:C.amber, fontSize:15, fontWeight:600 }}>Verifying angle...</p>
          </div>
        )}

        {/* Auto-capture ring */}
        {clothingOk && !isVerifying && !checkingClothing && (
          <div style={{ position:"absolute", bottom:14, right:14, zIndex:20 }}>
            <svg width={88} height={88} viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="44" fill="rgba(0,0,0,0.75)" stroke="rgba(255,255,255,0.07)" strokeWidth="8"/>
              <circle cx="50" cy="50" r="44" fill="none"
                stroke={fillPct >= 100 ? C.green : C.gold} strokeWidth="8"
                strokeDasharray={`${circ * fillPct / 100} ${circ}`}
                strokeLinecap="round" transform="rotate(-90 50 50)"
                style={{ transition:"stroke-dasharray 0.12s ease" }}/>
              <text x="50" y="46" textAnchor="middle" fill={C.gold}
                fontSize="14" fontWeight="800" fontFamily="DM Sans,sans-serif">
                {fillPct < 100 ? `${fillPct}%` : "✓"}
              </text>
              <text x="50" y="62" textAnchor="middle" fill={C.muted}
                fontSize="9" fontFamily="DM Sans,sans-serif">auto</text>
            </svg>
          </div>
        )}
      </div>

      {/* Score bar */}
      <div style={{ height:3, background:"#1a1a1a" }}>
        <div style={{ height:"100%", width:`${poseScore}%`, background:scoreColor, transition:"width 0.2s ease, background 0.3s" }}/>
      </div>

      {/* Guidance */}
      <div style={{ background:"#080808", padding:"12px 16px 10px" }}>
        {phaseLabel && clothingOk && (
          <div style={{ marginBottom:6, display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ background:"#1a1400", border:`1px solid ${C.gold}33`,
              borderRadius:20, padding:"3px 12px", fontSize:12, fontWeight:700, color:C.gold }}>
              {phaseLabel}
            </span>
            <span style={{ fontSize:11, color:C.muted }}>
              Pose: <span style={{ color:scoreColor, fontWeight:700 }}>{poseScore}%</span>
            </span>
          </div>
        )}
        <p style={{ fontSize:15, color:C.text, lineHeight:1.55, margin:0 }}>{guidance}</p>
        {clothingOk && !isVerifying && (
          <p style={{ ...S.hint, marginTop:5 }}>
            {fillPct < 100 ? "Capturing automatically when your position is steady" : "Captured! Preparing next angle..."}
          </p>
        )}
      </div>

      {/* Clothing concern buttons */}
      {hasConcern && !clothingOk && (
        <div style={{ display:"flex", gap:10, padding:"10px 14px 14px", background:"#0d0d0d" }}>
          <button style={{ ...S.btn2, flex:1, fontSize:13 }} onClick={onContinueAnyway}>
            Continue anyway
          </button>
          <button style={{ ...S.btn, flex:1, fontSize:13, padding:"13px" }}
            onClick={() => speak("Take your time — I'll be here when you're ready.", false)}>
            I'll change ✓
          </button>
        </div>
      )}
    </div>
  );
}

// ─── PROCESSING ───────────────────────────────────────────────────────────────
function ProcessingScreen() {
  const [step, setStep] = useState(0);
  const steps = [
    "Comparing all 4 angles...",
    "Calibrating scale from height...",
    "Extracting body silhouette widths...",
    "Calculating 3D circumferences...",
    "Applying Indian proportion check...",
    "Finalising your measurements...",
  ];
  useEffect(() => {
    const t = setInterval(() => setStep(s => Math.min(s+1, steps.length-1)), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ ...S.page, alignItems:"center", justifyContent:"center", textAlign:"center" }}>
      <div style={{ fontSize:52 }}>🐝</div>
      <h2 style={{ fontSize:22, fontWeight:800, color:C.gold, marginTop:12 }}>Gemini Pro measuring...</h2>
      <p style={{ fontSize:13, color:C.muted, marginTop:6 }}>Using vision AI on all 4 photos</p>
      <div style={{ marginTop:24, width:"100%", maxWidth:300 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12,
            opacity: i <= step ? 1 : 0.2, transition:"opacity 0.4s" }}>
            <div style={{ width:20, height:20, borderRadius:"50%", flexShrink:0,
              background: i < step ? C.green : i === step ? C.gold : C.border,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700 }}>
              {i < step ? "✓" : i === step ? (
                <div style={{ width:10, height:10, borderRadius:"50%",
                  border:`2px solid #111`, borderTopColor:"transparent",
                  animation:"spin 0.6s linear infinite" }}/>
              ) : ""}
            </div>
            <span style={{ fontSize:13, color: i <= step ? C.text : C.muted, textAlign:"left" }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── RESULTS ──────────────────────────────────────────────────────────────────
function ResultsScreen({ measurements, garment, aiAnalysis, confidence, onRemeasure }) {
  const g = GARMENTS[garment];
  const [copied, setCopied] = useState(false);

  const confColor = (key) => {
    const c = confidence?.[key];
    if (c === 'high')   return C.green;
    if (c === 'low')    return C.red;
    return C.amber;
  };

  const copy = () => {
    const lines = g.measurements
      .filter(k => measurements?.[k] != null)
      .map(k => `${MEASUREMENT_LABELS[k]}: ${measurements[k]} cm`)
      .join("\n");
    navigator.clipboard.writeText(`TailorBee v4 — ${g.label}\n${"─".repeat(28)}\n${lines}\n\nGenerated by TailorBee AI`);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop:12 }}>
        <div style={{ fontSize:44 }}>🐝</div>
        <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px", margin:"8px 0 4px" }}>Your Measurements</h2>
        <p style={{ color:C.amber, fontSize:15, fontWeight:600 }}>{g?.emoji} {g?.label}</p>
      </div>

      {/* Angle badges */}
      <div style={{ display:"flex", gap:7, justifyContent:"center", flexWrap:"wrap" }}>
        {ANGLES.map(a => (
          <span key={a.key} style={{ background:"#0d1a0d", border:`1px solid #2a4a2a`,
            borderRadius:20, padding:"3px 11px", fontSize:11, color:C.green }}>
            ✓ {a.label}
          </span>
        ))}
      </div>

      {/* AI analysis */}
      {aiAnalysis && (
        <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}44` }}>
          <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.12em",
            textTransform:"uppercase", color:C.amber }}>✨ Gemini Analysis</span>
          <p style={{ fontSize:14, color:C.text, marginTop:8, lineHeight:1.7 }}>{aiAnalysis}</p>
        </div>
      )}

      {/* Measurements table */}
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {g?.measurements.map((key, i) => {
          const val = measurements?.[key];
          if (val == null) return null;
          return (
            <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"12px 16px", background: i%2===0 ? C.card : C.surface, borderRadius:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:14, color:C.muted, fontWeight:500 }}>{MEASUREMENT_LABELS[key]}</span>
                {confidence?.[key] && (
                  <span style={{ fontSize:10, color:confColor(key),
                    border:`1px solid ${confColor(key)}44`, borderRadius:4, padding:"1px 6px", fontWeight:700 }}>
                    {confidence[key]}
                  </span>
                )}
              </div>
              <span style={{ fontSize:21, fontWeight:800, color:C.gold }}>
                {parseFloat(val).toFixed(1)}
                <span style={{ fontSize:12, fontWeight:400, color:C.muted }}> cm</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:14, justifyContent:"center" }}>
        {[[C.green,"High confidence"],[C.amber,"Estimated"],[C.red,"Low confidence"]].map(([c,l]) => (
          <span key={l} style={{ fontSize:11, color:c }}>● {l}</span>
        ))}
      </div>

      <div style={{ display:"flex", gap:10 }}>
        <button style={{ ...S.btn2, flex:1 }} onClick={copy}>{copied ? "✅ Copied!" : "📋 Copy"}</button>
        <button style={{ ...S.btn, flex:2 }} onClick={onRemeasure}>Measure Again →</button>
      </div>

      <p style={{ ...S.hint, textAlign:"center", fontSize:11 }}>
        ⚡ Gemini Vision estimates ±3–5 cm. For precision tailoring, verify with a tape measure.
      </p>
    </div>
  );
}
