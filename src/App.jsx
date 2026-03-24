import { useState, useRef, useEffect, useCallback } from "react";
import { GARMENTS, MEASUREMENT_LABELS } from "./garments.js";
import { scorePose, drawSkeleton, LM } from "./poseQuality.js";
import { speak, stopSpeaking, setLang, getLang } from "./voice.js";
import {
  geminiEnabled, frameToBase64,
  checkClothing, verifyAngle, extractMeasurements, getPoseGuidance
} from "./gemini.js";

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:"#0a0a0a", surface:"#121212", card:"#1a1a1a",
  border:"#242424", gold:"#FFD700", amber:"#FFA726",
  green:"#66BB6A", red:"#EF5350", blue:"#42A5F5",
  text:"#f0f0f0", muted:"#686868",
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

// Scan flow definition
const ANGLES = [
  { key:"front", label:"Front",      nudge:"Face the camera directly" },
  { key:"right", label:"Right Side", nudge:"Turn your RIGHT side to the camera" },
  { key:"back",  label:"Back",       nudge:"Turn your BACK to the camera" },
  { key:"left",  label:"Left Side",  nudge:"Turn your LEFT side to the camera" },
];

// How many consecutive good frames before Gemini verifies + captures
const GOOD_FRAMES_NEEDED = 50; // ~1.7s at 30fps
const MIN_POSE_SCORE = 76;
const GUIDE_INTERVAL_MS = 5000; // Ask Gemini for guidance every 5s

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const poseRef     = useRef(null);
  const cameraRef   = useRef(null);
  const streamRef   = useRef(null);
  const goodFrames  = useRef(0);
  const capturedPhotos = useRef({}); // { front, right, back, left } base64
  const lastGuidanceTime = useRef(0);
  const lastGuidanceIssue = useRef('');
  const isVerifying = useRef(false);

  const [screen,       setScreen]       = useState("home");
  const [lang,         setLangState]    = useState("en");
  const [garment,      setGarment]      = useState(null);
  const [height,       setHeight]       = useState("");
  const [facingMode,   setFacingMode]   = useState("user");
  const [mpLoaded,     setMpLoaded]     = useState(false);
  const [angleIdx,     setAngleIdx]     = useState(0);
  const [poseScore,    setPoseScore]    = useState(0);
  const [guidance,     setGuidance]     = useState("Starting camera...");
  const [fillPct,      setFillPct]      = useState(0);
  const [phaseLabel,   setPhaseLabel]   = useState("");
  const [measurements, setMeasurements] = useState(null);
  const [aiAnalysis,   setAiAnalysis]   = useState("");
  const [confidence,   setConfidence]   = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [clothingOk,   setClothingOk]   = useState(false);
  const [checkingClothing, setCheckingClothing] = useState(false);

  // Poll for MediaPipe
  useEffect(() => {
    const t = setInterval(() => { if (window.Pose) { setMpLoaded(true); clearInterval(t); } }, 300);
    return () => clearInterval(t);
  }, []);

  const switchLang = (l) => {
    setLangState(l);
    setLang(l);
  };

  // ── Start camera ─────────────────────────────────────────────────────────
  const startCamera = useCallback(async (facing = facingMode, onReadyCb = null) => {
    if (!window.Pose) return;

    // Teardown existing
    cameraRef.current?.stop?.();
    poseRef.current?.close?.();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());

    const pose = new window.Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
    });
    pose.setOptions({
      modelComplexity:1, smoothLandmarks:true,
      enableSegmentation:false,
      minDetectionConfidence:0.6, minTrackingConfidence:0.6,
    });

    pose.onResults(results => {
      const canvas = canvasRef.current;
      const video  = videoRef.current;
      if (!canvas || !video) return;

      const ctx = canvas.getContext("2d");
      const W = canvas.width  = video.videoWidth  || 640;
      const H = canvas.height = video.videoHeight || 480;

      ctx.save();
      if (facing === "user") { ctx.scale(-1,1); ctx.drawImage(results.image, -W, 0, W, H); }
      else ctx.drawImage(results.image, 0, 0, W, H);
      ctx.restore();

      const lm = results.poseLandmarks;
      if (!lm) {
        goodFrames.current = 0;
        setPoseScore(0); setFillPct(0);
        setGuidance("Step in front of the camera");
        return;
      }

      drawSkeleton(ctx, lm, W, H, facing === "user");

      const currentAngle = ANGLES[angleIdx]?.key || 'front';
      const { score, ready } = scorePose(lm, W, H, currentAngle);
      setPoseScore(score);

      if (ready && !isVerifying.current && !isProcessing) {
        goodFrames.current++;
        const pct = Math.min(100, Math.round(goodFrames.current / GOOD_FRAMES_NEEDED * 100));
        setFillPct(pct);

        if (goodFrames.current === 10) setGuidance("Good — hold that position...");
        if (goodFrames.current === 30) setGuidance("Almost there, keep still...");

        if (goodFrames.current >= GOOD_FRAMES_NEEDED) {
          // Enough good frames — capture and verify with Gemini
          handleAutoCapture(canvas, currentAngle);
        }
      } else {
        goodFrames.current = Math.max(0, goodFrames.current - 3);
        setFillPct(Math.max(0, Math.round(goodFrames.current / GOOD_FRAMES_NEEDED * 100)));

        // Ask Gemini for guidance every GUIDE_INTERVAL_MS
        const now = Date.now();
        if (now - lastGuidanceTime.current > GUIDE_INTERVAL_MS && !isVerifying.current) {
          lastGuidanceTime.current = now;
          requestGeminiGuidance(canvas, currentAngle);
        }
      }
    });

    poseRef.current = pose;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width:{ ideal:640 }, height:{ ideal:480 } },
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
  }, [facingMode, angleIdx, isProcessing]);

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop?.();
    poseRef.current?.close?.();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, []);

  // ── Gemini real-time guidance ─────────────────────────────────────────────
  const requestGeminiGuidance = async (canvas, angle) => {
    if (!geminiEnabled()) return;
    const b64 = frameToBase64(canvas);
    const msg = await getPoseGuidance(b64, angle, lastGuidanceIssue.current, getLang());
    if (msg) {
      setGuidance(msg);
      speak(msg, false);
      lastGuidanceIssue.current = msg;
    }
  };

  // ── Clothing check (first frame) ─────────────────────────────────────────
  const doClothingCheck = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !geminiEnabled()) { setClothingOk(true); return; }
    setCheckingClothing(true);
    setGuidance("Checking your outfit...");
    const b64 = frameToBase64(canvas);
    const msg = await checkClothing(b64, getLang());
    setCheckingClothing(false);
    setGuidance(msg);
    speak(msg, true);

    // If message contains concern words, wait for user confirmation
    const concernWords = ['loose', 'baggy', 'nighty', 'change', 'fitted', 'accuracy', 'suggest',
      'ഢഗഗ', 'loose', 'മാറ്', 'ഫിറ്റ്'];
    const hasConcern = concernWords.some(w => msg.toLowerCase().includes(w));
    if (!hasConcern) {
      setClothingOk(true);
      startAngle(0);
    }
    // If concern — UI shows "Continue anyway" + "I'll change" buttons
  };

  // ── Start a specific angle ────────────────────────────────────────────────
  const startAngle = (idx) => {
    setAngleIdx(idx);
    goodFrames.current = 0;
    setFillPct(0);
    isVerifying.current = false;
    const angle = ANGLES[idx];
    const msg = idx === 0
      ? `Great, let's start. ${angle.nudge}.`
      : `Now for your ${angle.label} view. ${angle.nudge}.`;
    setGuidance(msg);
    speak(msg, true);
    setPhaseLabel(`${idx + 1} of 4 — ${angle.label}`);
  };

  // ── Auto-capture when pose is steady ─────────────────────────────────────
  const handleAutoCapture = async (canvas, angleKey) => {
    if (isVerifying.current) return;
    isVerifying.current = true;
    goodFrames.current = 0;
    setFillPct(100);

    const msg = "Checking your position...";
    setGuidance(msg);

    const b64 = frameToBase64(canvas);

    // Gemini verifies the angle is actually correct
    const result = await verifyAngle(b64, angleKey, getLang());

    if (result.verified && result.quality !== 'poor') {
      // ✅ Capture accepted
      capturedPhotos.current[angleKey] = b64;
      setGuidance(result.message || `${ANGLES[angleIdx]?.label} captured!`);
      speak(result.message || `${ANGLES[angleIdx]?.label} captured!`, true);

      const nextIdx = ANGLES.findIndex(a => a.key === angleKey) + 1;

      setTimeout(() => {
        if (nextIdx < ANGLES.length) {
          isVerifying.current = false;
          setFillPct(0);
          startAngle(nextIdx);
        } else {
          // All 4 done — process with Gemini Vision
          finalizeMeasurements();
        }
      }, 1800);

    } else {
      // ❌ Not correct angle — Gemini explains what to fix
      isVerifying.current = false;
      setFillPct(0);
      const errMsg = result.message || "Let's try that again.";
      setGuidance(errMsg);
      speak(errMsg, true);
    }
  };

  // ── Final measurement extraction ──────────────────────────────────────────
  const finalizeMeasurements = async () => {
    stopCamera();
    setIsProcessing(true);
    setScreen("processing");

    const photos = ANGLES.map(a => capturedPhotos.current[a.key] || null);
    const g = GARMENTS[garment];
    const heightCm = parseFloat(height) || 165;

    speak("I have all four photos. Analysing your measurements now...", true);

    const result = await extractMeasurements(
      photos, g.label, g.geminiContext, heightCm, getLang()
    );

    setMeasurements(result.measurements || {});
    setAiAnalysis(result.analysis || "Measurements complete.");
    setConfidence(result.confidence || {});
    setIsProcessing(false);
    setScreen("results");

    if (result.analysis) {
      setTimeout(() => speak(result.analysis, true), 500);
    }
  };

  // ── Camera swap ───────────────────────────────────────────────────────────
  const swapCamera = () => {
    const next = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
    goodFrames.current = 0;
    setFillPct(0);
    startCamera(next);
  };

  // ── Screen router ─────────────────────────────────────────────────────────
  return (
    <div style={{ background:C.bg, minHeight:"100vh" }}>
      {screen === "home"       && <HomeScreen    lang={lang} switchLang={switchLang} setScreen={setScreen} />}
      {screen === "garment"    && <GarmentScreen setScreen={setScreen} setGarment={setGarment} />}
      {screen === "setup"      && (
        <SetupScreen
          setScreen={setScreen} garment={garment}
          height={height} setHeight={setHeight}
          mpLoaded={mpLoaded}
          onStart={() => {
            capturedPhotos.current = {};
            setMeasurements(null); setAiAnalysis("");
            setAngleIdx(0); goodFrames.current = 0;
            setClothingOk(false);
            setScreen("scan");
            setTimeout(() => {
              startCamera(facingMode, () => {
                // After camera ready, do clothing check
                setTimeout(doClothingCheck, 2000);
              });
            }, 300);
          }}
        />
      )}
      {screen === "scan" && (
        <ScanScreen
          videoRef={videoRef} canvasRef={canvasRef}
          angleIdx={angleIdx} poseScore={poseScore}
          guidance={guidance} fillPct={fillPct}
          phaseLabel={phaseLabel}
          isVerifying={isVerifying.current}
          checkingClothing={checkingClothing}
          clothingOk={clothingOk}
          facingMode={facingMode} swapCamera={swapCamera}
          onContinueAnyway={() => { setClothingOk(true); startAngle(0); }}
          onBack={() => { stopCamera(); stopSpeaking(); setScreen("setup"); }}
          capturedPhotos={capturedPhotos.current}
        />
      )}
      {screen === "processing" && <ProcessingScreen />}
      {screen === "results" && (
        <ResultsScreen
          measurements={measurements} garment={garment}
          aiAnalysis={aiAnalysis} confidence={confidence}
          lang={lang}
          onRemeasure={() => {
            capturedPhotos.current = {};
            setMeasurements(null); setAiAnalysis("");
            setScreen("garment");
          }}
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
          AI Measurement System v3
        </p>
        <p style={{ fontSize:14, color:C.muted, marginTop:10, lineHeight:1.7, maxWidth:320, margin:"10px auto 0" }}>
          Gemini AI analyses your photos from 4 angles to estimate clothing measurements — guided by voice.
        </p>
      </div>

      {/* Language */}
      <div style={S.card}>
        <span style={S.label}>🌐 Language / ഭാഷ</span>
        <div style={{ display:"flex", gap:10 }}>
          {[["en","English 🇬🇧"],["ml","മലയാളം 🇮🇳"]].map(([l, label]) => (
            <button key={l}
              style={{ flex:1, padding:"12px", borderRadius:10, cursor:"pointer", fontWeight:700, fontSize:14, transition:"all 0.2s",
                border:`2px solid ${lang===l ? C.gold : C.border}`,
                background: lang===l ? "#1a1400" : C.surface,
                color: lang===l ? C.gold : C.muted }}
              onClick={() => switchLang(l)}>{label}</button>
          ))}
        </div>
      </div>

      {/* Gemini status */}
      <div style={{ ...S.card, display:"flex", gap:12, alignItems:"flex-start" }}>
        <span style={{ fontSize:24, marginTop:2 }}>{geminiEnabled() ? "✅" : "⚠️"}</span>
        <div>
          <p style={{ fontSize:14, fontWeight:700, color: geminiEnabled() ? C.green : C.amber, margin:0 }}>
            {geminiEnabled() ? "Gemini Vision active" : "Gemini not configured"}
          </p>
          <p style={{ ...S.hint, marginTop:4 }}>
            {geminiEnabled()
              ? "AI will analyse your photos for measurements and guide you with voice."
              : "Add VITE_GEMINI_API_KEY to your .env file. Without it, measurements won't work."}
          </p>
        </div>
      </div>

      {/* How it works */}
      <div style={S.card}>
        <span style={S.label}>How it works</span>
        {[
          ["1","Select your garment & enter height"],
          ["2","Camera checks your outfit first"],
          ["3","Gemini guides you through 4 poses — no touching the phone"],
          ["4","Gemini Vision analyses all 4 photos & gives measurements"],
        ].map(([n, t]) => (
          <div key={n} style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:10 }}>
            <span style={{ width:26, height:26, borderRadius:"50%", background:"#1a1400", border:`1px solid ${C.gold}33`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:12, fontWeight:800, color:C.gold, flexShrink:0, marginTop:1 }}>{n}</span>
            <span style={{ fontSize:14, color:C.muted, lineHeight:1.5 }}>{t}</span>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexWrap:"wrap", gap:7, justifyContent:"center" }}>
        {["🧠 Gemini Vision","🔄 4-angle scan","🎙️ AI voice guide","📱 No button needed","🔒 Private"].map(f => (
          <span key={f} style={{ background:C.surface, border:`1px solid ${C.border}`,
            borderRadius:20, padding:"5px 12px", fontSize:11, color:C.muted }}>{f}</span>
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
      <p style={{ ...S.hint, margin:0 }}>Gemini will know exactly which measurements to take.</p>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        {Object.entries(GARMENTS).map(([key, g]) => (
          <button key={key}
            style={{ ...S.card, display:"flex", flexDirection:"column", alignItems:"center",
              gap:5, cursor:"pointer", padding:"18px 10px", transition:"border-color 0.2s",
              border:`1px solid ${C.border}` }}
            onMouseEnter={e => e.currentTarget.style.borderColor=C.gold}
            onMouseLeave={e => e.currentTarget.style.borderColor=C.border}
            onClick={() => { setGarment(key); setScreen("setup"); }}
          >
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
function SetupScreen({ setScreen, garment, height, setHeight, mpLoaded, onStart }) {
  const g = GARMENTS[garment];
  return (
    <div style={S.page}>
      <button style={S.back} onClick={() => setScreen("garment")}>← Back</button>
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px" }}>Setup</h2>

      <div style={S.card}>
        <span style={S.label}>📏 Your height (cm) — critical for calibration</span>
        <input style={{ ...S.card, background:"#111", color:C.text, fontSize:22, fontWeight:800,
          width:"100%", border:`1px solid ${C.border}`, outline:"none", padding:"14px", textAlign:"center" }}
          type="number" placeholder="e.g. 162"
          value={height} onChange={e => setHeight(e.target.value)}
          onFocus={e => e.target.style.borderColor=C.gold}
          onBlur={e => e.target.style.borderColor=C.border}
        />
        <p style={S.hint}>Gemini uses your height to calibrate pixel-to-cm conversion in the photos.</p>
      </div>

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

      <div style={{ ...S.card, background:"#0d1a0d", border:`1px solid #2a4a2a` }}>
        <span style={S.label}>🎙️ What Gemini will do</span>
        <p style={{ fontSize:13, color:C.muted, lineHeight:1.7 }}>
          • Check your outfit before starting<br/>
          • Guide you in {"{language}"} to turn through 4 angles<br/>
          • Verify each angle is correct before capturing<br/>
          • Analyse all 4 photos together for measurements<br/>
          • Explain your results and flag anything unusual
        </p>
      </div>

      <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}33` }}>
        <span style={S.label}>💡 For best accuracy</span>
        <p style={{ fontSize:13, color:C.muted, lineHeight:1.8 }}>
          • Wear a fitted t-shirt + leggings (Gemini will remind you)<br/>
          • Stand 1.5–2 metres from camera<br/>
          • Good lighting — avoid standing against a window<br/>
          • Keep arms slightly away from your body
        </p>
      </div>

      {!mpLoaded && (
        <div style={{ textAlign:"center", color:C.muted, fontSize:13, padding:"8px 0" }}>
          <div style={{ width:"100%", height:3, background:C.border, borderRadius:2, overflow:"hidden", marginBottom:8 }}>
            <div style={{ height:"100%", width:"60%", background:C.gold, animation:"pulse 1.2s ease-in-out infinite" }}/>
          </div>
          Loading AI pose engine...
        </div>
      )}

      <button style={{ ...S.btn, opacity: mpLoaded && height ? 1 : 0.5 }}
        disabled={!mpLoaded || !height} onClick={onStart}>
        {mpLoaded ? (height ? "Start AI Scan →" : "Enter your height first") : "Loading..."}
      </button>
    </div>
  );
}

// ─── SCAN SCREEN ──────────────────────────────────────────────────────────────
function ScanScreen({ videoRef, canvasRef, angleIdx, poseScore, guidance, fillPct,
  phaseLabel, isVerifying, checkingClothing, clothingOk, facingMode, swapCamera,
  onContinueAnyway, onBack, capturedPhotos }) {

  const angle = ANGLES[angleIdx] || ANGLES[0];
  const scoreColor = poseScore >= MIN_POSE_SCORE ? C.green : poseScore >= 50 ? C.amber : C.red;
  const circ = 2 * Math.PI * 44;

  // Detect if clothing concern message
  const hasConcern = !clothingOk && guidance && (
    guidance.toLowerCase().includes('change') ||
    guidance.toLowerCase().includes('loose') ||
    guidance.toLowerCase().includes('baggy') ||
    guidance.toLowerCase().includes('fitted') ||
    guidance.includes('മാറ്') ||
    guidance.includes('ഫിറ്റ്')
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:"#000" }}>

      {/* Top bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 14px", background:"rgba(0,0,0,0.92)", backdropFilter:"blur(12px)", zIndex:10 }}>
        <button style={{ ...S.back, fontSize:20, color:"#fff" }} onClick={onBack}>✕</button>

        {/* Angle dots */}
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {ANGLES.map((a, i) => {
            const done = !!capturedPhotos[a.key];
            return (
              <div key={a.key} style={{
                width: i === angleIdx ? 28 : 8, height:8, borderRadius:4,
                background: done ? C.green : i === angleIdx ? C.gold : C.border,
                transition:"all 0.4s ease",
                display:"flex", alignItems:"center", justifyContent:"center"
              }}>
                {done && i !== angleIdx && (
                  <span style={{ fontSize:6, color:"#111" }}>✓</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Camera swap */}
        <button onClick={swapCamera}
          style={{ background:"rgba(255,255,255,0.08)", border:`1px solid ${C.border}`,
            borderRadius:20, padding:"5px 12px", color:"#fff", fontSize:12, fontWeight:600, cursor:"pointer" }}>
          {facingMode === "user" ? "🔄 Rear" : "🔄 Front"}
        </button>
      </div>

      {/* Camera view */}
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
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%",
          pointerEvents:"none", opacity:0.1 }} viewBox="0 0 100 160" preserveAspectRatio="xMidYMid meet">
          <ellipse cx="50" cy="10" rx="7" ry="8" fill="none" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="18" x2="50" y2="72" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="27" y1="29" x2="73" y2="29" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="72" x2="37" y2="128" stroke={C.gold} strokeWidth="0.8"/>
          <line x1="50" y1="72" x2="63" y2="128" stroke={C.gold} strokeWidth="0.8"/>
        </svg>

        {/* Checking clothing overlay */}
        {checkingClothing && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.65)",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14 }}>
            <div style={{ width:44, height:44, border:`3px solid ${C.gold}33`,
              borderTop:`3px solid ${C.gold}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
            <p style={{ color:"#fff", fontSize:15, fontWeight:600 }}>Checking your outfit...</p>
          </div>
        )}

        {/* Verifying overlay */}
        {isVerifying && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.55)",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14,
            animation:"popIn 0.3s ease" }}>
            <div style={{ width:44, height:44, border:`3px solid ${C.amber}33`,
              borderTop:`3px solid ${C.amber}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
            <p style={{ color:C.amber, fontSize:15, fontWeight:600 }}>Verifying position...</p>
          </div>
        )}

        {/* Auto-capture ring (bottom right) */}
        {clothingOk && !isVerifying && !checkingClothing && (
          <div style={{ position:"absolute", bottom:14, right:14, zIndex:20 }}>
            <svg width={88} height={88} viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="44" fill="rgba(0,0,0,0.72)"
                stroke="rgba(255,255,255,0.08)" strokeWidth="8"/>
              <circle cx="50" cy="50" r="44" fill="none"
                stroke={fillPct >= 100 ? C.green : C.gold} strokeWidth="8"
                strokeDasharray={`${circ * fillPct / 100} ${circ}`}
                strokeLinecap="round" transform="rotate(-90 50 50)"
                style={{ transition:"stroke-dasharray 0.12s ease" }}/>
              <text x="50" y="46" textAnchor="middle"
                fill={C.gold} fontSize="14" fontWeight="800" fontFamily="DM Sans, sans-serif">
                {fillPct < 100 ? `${fillPct}%` : "✓"}
              </text>
              <text x="50" y="62" textAnchor="middle"
                fill={C.muted} fontSize="9" fontFamily="DM Sans, sans-serif">auto</text>
            </svg>
          </div>
        )}
      </div>

      {/* Score bar */}
      <div style={{ height:3, background:"#1a1a1a" }}>
        <div style={{ height:"100%", width:`${poseScore}%`, background:scoreColor,
          transition:"width 0.2s ease, background 0.3s" }}/>
      </div>

      {/* Guidance */}
      <div style={{ background:"#080808", padding:"12px 16px 10px" }}>
        {phaseLabel && clothingOk && (
          <div style={{ marginBottom:6 }}>
            <span style={{ background:"#1a1400", border:`1px solid ${C.gold}33`,
              borderRadius:20, padding:"3px 12px", fontSize:12, fontWeight:700, color:C.gold }}>
              {phaseLabel}
            </span>
            <span style={{ fontSize:11, color:C.muted, marginLeft:10 }}>
              Score: <span style={{ color:scoreColor, fontWeight:700 }}>{poseScore}%</span>
            </span>
          </div>
        )}
        <p style={{ fontSize:15, color:C.text, lineHeight:1.55, margin:0 }}>{guidance}</p>
        {clothingOk && !isVerifying && (
          <p style={{ ...S.hint, marginTop:5 }}>
            {fillPct < 100
              ? "Auto-capturing when your position looks good"
              : "Position verified — capturing..."}
          </p>
        )}
      </div>

      {/* Clothing concern buttons */}
      {hasConcern && (
        <div style={{ display:"flex", gap:10, padding:"10px 14px", background:"#0d0d0d" }}>
          <button style={{ ...S.btn2, flex:1, fontSize:13 }} onClick={onContinueAnyway}>
            Continue anyway
          </button>
          <button style={{ ...S.btn, flex:1, fontSize:13, padding:"13px" }}
            onClick={() => {
              speak("Take your time. I'll wait.", false);
            }}>
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
    "Analysing body silhouette...",
    "Calculating circumferences...",
    "Cross-checking measurements...",
    "Preparing your results...",
  ];
  useEffect(() => {
    const t = setInterval(() => setStep(s => Math.min(s+1, steps.length-1)), 1800);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ ...S.page, alignItems:"center", justifyContent:"center", textAlign:"center" }}>
      <div style={{ fontSize:52 }}>🐝</div>
      <h2 style={{ fontSize:22, fontWeight:800, color:C.gold, marginTop:12 }}>Gemini is measuring...</h2>
      <div style={{ marginTop:24, width:"100%", maxWidth:320 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12,
            opacity: i <= step ? 1 : 0.25, transition:"opacity 0.4s" }}>
            <span style={{ width:20, height:20, borderRadius:"50%", flexShrink:0,
              background: i < step ? C.green : i === step ? C.gold : C.border,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:10 }}>
              {i < step ? "✓" : i === step ? (
                <span style={{ width:10, height:10, borderRadius:"50%",
                  border:`2px solid #111`, borderTopColor:"transparent",
                  animation:"spin 0.6s linear infinite", display:"block" }}/>
              ) : ""}
            </span>
            <span style={{ fontSize:14, color: i <= step ? C.text : C.muted }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── RESULTS ──────────────────────────────────────────────────────────────────
function ResultsScreen({ measurements, garment, aiAnalysis, confidence, lang, onRemeasure }) {
  const g = GARMENTS[garment];
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState("measurements");

  const confidenceColor = (key) => {
    const c = confidence?.[key];
    if (c === 'high') return C.green;
    if (c === 'low') return C.red;
    return C.amber;
  };

  const copy = () => {
    const lines = g.measurements
      .filter(k => measurements?.[k])
      .map(k => `${MEASUREMENT_LABELS[k]}: ${measurements[k]} cm`)
      .join("\n");
    navigator.clipboard.writeText(`TailorBee Measurements — ${g.label}\n${"─".repeat(28)}\n${lines}\n\nGenerated by TailorBee AI v3`);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={S.page}>
      <div style={{ textAlign:"center", paddingTop:12 }}>
        <div style={{ fontSize:44 }}>🐝</div>
        <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px", margin:"8px 0 4px" }}>
          Your Measurements
        </h2>
        <p style={{ color:C.amber, fontSize:15, fontWeight:600 }}>{g?.emoji} {g?.label}</p>
      </div>

      {/* Angle capture badges */}
      <div style={{ display:"flex", gap:7, justifyContent:"center", flexWrap:"wrap" }}>
        {ANGLES.map(a => (
          <span key={a.key} style={{ background:"#0d1a0d", border:`1px solid #2a4a2a`,
            borderRadius:20, padding:"3px 11px", fontSize:11, color:C.green }}>
            ✓ {a.label}
          </span>
        ))}
      </div>

      {/* AI Analysis */}
      {aiAnalysis && (
        <div style={{ ...S.card, background:"#1a1400", border:`1px solid ${C.amber}44` }}>
          <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.12em",
            textTransform:"uppercase", color:C.amber }}>✨ Gemini Analysis</span>
          <p style={{ fontSize:14, color:C.text, marginTop:8, lineHeight:1.7 }}>{aiAnalysis}</p>
        </div>
      )}

      {/* Measurements */}
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {g?.measurements.map((key, i) => {
          const val = measurements?.[key];
          if (!val) return null;
          return (
            <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"13px 16px", background: i%2===0 ? C.card : C.surface, borderRadius:8 }}>
              <div>
                <span style={{ fontSize:14, color:C.muted, fontWeight:500 }}>{MEASUREMENT_LABELS[key]}</span>
                {confidence?.[key] && (
                  <span style={{ marginLeft:8, fontSize:10, color:confidenceColor(key),
                    border:`1px solid ${confidenceColor(key)}44`, borderRadius:4,
                    padding:"1px 6px", fontWeight:600 }}>
                    {confidence[key]}
                  </span>
                )}
              </div>
              <span style={{ fontSize:22, fontWeight:800, color:C.gold }}>
                {parseFloat(val).toFixed(1)}
                <span style={{ fontSize:12, fontWeight:400, color:C.muted }}> cm</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Confidence legend */}
      {Object.keys(confidence || {}).length > 0 && (
        <div style={{ display:"flex", gap:14, justifyContent:"center" }}>
          {[["high", C.green, "High confidence"],["medium", C.amber, "Estimated"],["low", C.red, "Low confidence"]].map(([k,c,l]) => (
            <span key={k} style={{ fontSize:11, color:c }}>● {l}</span>
          ))}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display:"flex", gap:10 }}>
        <button style={{ ...S.btn2, flex:1 }} onClick={copy}>
          {copied ? "✅ Copied!" : "📋 Copy"}
        </button>
        <button style={{ ...S.btn, flex:2 }} onClick={onRemeasure}>Measure Again →</button>
      </div>

      <p style={{ ...S.hint, textAlign:"center", fontSize:11 }}>
        ⚡ AI estimates ±3–5 cm — for fine tailoring, verify critical measurements with a tape measure.
      </p>
    </div>
  );
}

const MIN_POSE_SCORE = 76;
