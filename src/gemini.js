// ─── Gemini Client v4 ─────────────────────────────────────────────────────────
// Improvements over v3:
// - Uses gemini-1.5-pro for measurements (better vision reasoning)
// - Two-pass measurement: extract → sanity-check → correct
// - Indian body proportion priors baked into prompts
// - Better error recovery

const KEY = import.meta.env.VITE_GEMINI_API_KEY;

// Use Pro for measurements (better accuracy), Flash for real-time guidance (speed)
const PRO_URL   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${KEY}`;
const FLASH_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${KEY}`;

export const geminiEnabled = () => !!KEY && KEY !== 'paste_your_gemini_key_here';

export function frameToBase64(canvas) {
  return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
}

// ─── Clothing check ───────────────────────────────────────────────────────────
export async function checkClothing(base64img, lang) {
  const langNote = lang === 'ml'
    ? 'Reply in Malayalam (മലയാളം). Be warm and friendly like a shop assistant.'
    : 'Reply in English. Be warm and friendly like a shop assistant.';

  const prompt = `You are TailorBee's AI assistant helping a customer take body measurements in India.
${langNote}

Examine this photo carefully.

SUITABLE clothing (shows body shape): fitted t-shirt, leggings, churidar, fitted kurta, sportswear, tank top, fitted dress.
NOT SUITABLE (hides body shape): loose nighty, baggy salwar, oversized shirt, heavy dupatta draped over body, thick saree, loose gown, blanket/shawl, very baggy anything.

Respond with ONLY what you'd say out loud — natural, warm, conversational. No labels or JSON.

If NOT suitable: Explain warmly in 2 sentences what to change and why. E.g. "I can see you're wearing a loose nighty — that will make it hard to get accurate measurements. Could you change into a fitted t-shirt and leggings? It only takes 2 minutes and makes a big difference!"
If suitable: One warm sentence like "You look perfectly dressed for measurements — let's get started!"
If no person visible: Ask them to step in front of the camera.`;

  return callFlashVision(prompt, base64img);
}

// ─── Angle verification ───────────────────────────────────────────────────────
export async function verifyAngle(base64img, expectedAngle, lang) {
  const langNote = lang === 'ml' ? 'Write "message" in Malayalam.' : 'Write "message" in English.';

  const desc = {
    front: 'facing DIRECTLY at the camera — face clearly visible, shoulders square to camera, both feet visible',
    right: 'RIGHT side facing camera — only right ear/cheek visible, right shoulder closest to camera, profile view',
    back:  'BACK to camera — back of head visible, NO face visible, both shoulders visible from behind',
    left:  'LEFT side facing camera — only left ear/cheek visible, left shoulder closest to camera, profile view',
  };

  const prompt = `You are TailorBee's measurement assistant verifying a customer's position.
${langNote}

Required position: ${expectedAngle.toUpperCase()} view — person should be ${desc[expectedAngle]}.

Carefully examine this photo and respond ONLY with valid JSON:
{
  "verified": true or false,
  "quality": "good" or "acceptable" or "poor",
  "faceVisible": true or false,
  "fullBodyVisible": true or false,
  "issue": "specific issue description or null",
  "message": "What to say to customer — specific, helpful, warm. 1-2 sentences. If verified say something encouraging. If not, tell them EXACTLY what to fix."
}

Be strict: if it's supposed to be a side view but the person is still facing front, verified = false.`;

  const raw = await callFlashVision(prompt, base64img);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { verified: false, quality: 'poor', issue: 'Parse error', message: "Let's try that position again." };
  }
}

// ─── Main measurement extraction (v4: two-pass with sanity check) ─────────────
export async function extractMeasurements(photos, garmentLabel, garmentContext, heightCm, lang, gender) {
  const langNote = lang === 'ml' ? 'Write "analysis" in Malayalam.' : 'Write "analysis" in English.';

  // Indian body proportion reference ranges (for sanity checking)
  const priors = gender === 'male' ? `
INDIAN MALE BODY REFERENCE (use to sanity-check your estimates):
- Average height: 165 cm, Average bust/chest: 90-100 cm, Average waist: 80-90 cm, Average hip: 90-98 cm
- Shoulder width: typically 42-48 cm, Inseam: typically 74-82 cm` : `
INDIAN FEMALE BODY REFERENCE (use to sanity-check your estimates):
- Average height: 152 cm, Average bust: 84-96 cm, Average waist: 68-80 cm, Average hip: 90-102 cm
- Shoulder width: typically 36-42 cm, Inseam: typically 68-76 cm
- Waist-to-hip ratio: typically 0.75-0.85`;

  const prompt = `You are an expert AI body measurement system for TailorBee, an Indian tailoring service.
You have ${photos.filter(Boolean).length} photos: front, right side, back, left side.
Person's HEIGHT: ${heightCm} cm — this is your primary calibration reference.
Garment needed: ${garmentLabel} (${garmentContext})
${priors}
${langNote}

MEASUREMENT METHODOLOGY:
Step 1 — CALIBRATION: Use the person's height (${heightCm} cm) to calculate pixels-per-cm.
  - Measure pixel distance from top of head to bottom of feet in the front photo
  - scale = ${heightCm} / pixel_height_of_body

Step 2 — WIDTH EXTRACTION (from front photo):
  - Chest width: widest point of torso at chest level (pixels × scale × 2 for circumference approximation start)
  - Waist width: narrowest point of torso between chest and hips
  - Hip width: widest point of hips/buttocks
  - Shoulder width: distance between outer shoulder points

Step 3 — DEPTH EXTRACTION (from side photo):
  - Chest depth: widest measurement of torso from front to back at chest level
  - Waist depth: front-to-back at waist level
  - Hip depth: front-to-back at hip level

Step 4 — CIRCUMFERENCE (ellipse Ramanujan approximation):
  For each zone: C = π × (3(a+b) - √((3a+b)(a+3b))) where a=half-width, b=half-depth
  This gives much more accurate circumference than simple π×diameter.

Step 5 — LENGTH MEASUREMENTS (front photo, scaled):
  - Sleeve: shoulder point to wrist
  - Garment length: shoulder to desired hem level
  - Inseam: crotch to ankle (inner leg)
  - Rise: waistband to crotch (front)

Step 6 — SANITY CHECK: Compare your results to the reference ranges above.
  If any measurement is more than 20% outside the range for this height, re-examine and adjust.

CLOTHING CORRECTION: If person is wearing non-form-fitting clothing, subtract 2-3cm from circumferences.

Respond ONLY with valid JSON — no markdown, no explanation outside JSON:
{
  "measurements": {
    "bust": number,
    "waist": number,
    "hip": number,
    "shoulder_width": number,
    "sleeve_length": number,
    "garment_length": number,
    "inseam": number,
    "thigh": number,
    "knee": number,
    "calf": number,
    "ankle": number,
    "collar": number,
    "under_bust": number,
    "back_length": number,
    "rise": number
  },
  "confidence": {
    "bust": "high|medium|low",
    "waist": "high|medium|low",
    "hip": "high|medium|low",
    "shoulder_width": "high|medium|low",
    "sleeve_length": "high|medium|low"
  },
  "calibrationPxPerCm": number,
  "clothingNote": "brief note or null",
  "photosUsed": ["front","right","back","left"],
  "analysis": "2-3 sentences for the customer. Warm, specific. Mention confidence and any caveats. Flag unusual measurements."
}`;

  // Build parts array with all available photos
  const parts = [{ text: prompt }];
  const labels = ['Front view photo:', 'Right side photo:', 'Back view photo:', 'Left side photo:'];
  photos.forEach((b64, i) => {
    if (b64) {
      parts.push({ text: labels[i] });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
    }
  });

  // Use Pro model for maximum accuracy on measurements
  const raw = await callProVisionMulti(parts);

  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Post-process: round all measurements to 1 decimal
    if (result.measurements) {
      Object.keys(result.measurements).forEach(k => {
        if (result.measurements[k] !== null && result.measurements[k] !== undefined) {
          result.measurements[k] = parseFloat(parseFloat(result.measurements[k]).toFixed(1));
        }
      });
    }
    return result;
  } catch (e) {
    console.error('Measurement parse error:', e, '\nRaw:', raw.substring(0, 500));
    return {
      measurements: {},
      confidence: {},
      analysis: lang === 'ml'
        ? 'അളവുകൾ പ്രോസസ്സ് ചെയ്യുമ്പോൾ ഒരു പ്രശ്നം ഉണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കൂ.'
        : 'There was an issue processing measurements. Please try again.',
    };
  }
}

// ─── Real-time pose guidance (fast, Flash model) ──────────────────────────────
export async function getPoseGuidance(base64img, expectedAngle, previousIssue, lang) {
  const langNote = lang === 'ml'
    ? 'Reply in Malayalam (മലയാളം). Sound like a helpful friend.'
    : 'Reply in English. Sound like a helpful friend.';

  const needed = {
    front: 'standing straight, facing camera directly, arms slightly away from sides, full body head-to-feet visible',
    right: 'right side facing camera (profile), standing straight, full body visible',
    back:  'back facing camera (no face visible), standing straight, full body visible',
    left:  'left side facing camera (profile), standing straight, full body visible',
  };

  const prompt = `TailorBee measurement assistant. ${langNote}
Customer needs to be: ${needed[expectedAngle]}
Last noted issue: "${previousIssue || 'none'}"

Look at this live camera frame. Give ONE specific instruction under 18 words.
Be like a real person — notice exactly what's wrong.
Only say "Perfect, hold still" if everything genuinely looks correct.
No generic advice. No repeating the same thing if it was the last issue.
Reply with ONLY the spoken words.`;

  return callFlashVision(prompt, base64img);
}

// ─── Internal API callers ─────────────────────────────────────────────────────
async function callFlashVision(prompt, base64img) {
  if (!geminiEnabled()) return "Ready when you are.";
  try {
    const res = await fetch(FLASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64img } }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.35 },
      }),
    });
    if (!res.ok) { console.warn('Gemini Flash error:', res.status); return "Ready when you are."; }
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Ready when you are.";
  } catch (e) { console.warn('Flash vision error:', e); return "Ready when you are."; }
}

async function callProVisionMulti(parts) {
  if (!geminiEnabled()) return '{"measurements":{},"analysis":"Gemini API key not configured. Add it to your .env file."}';
  try {
    const res = await fetch(PRO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 1200, temperature: 0.15 },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn('Gemini Pro error:', res.status, err);
      // Fallback to Flash if Pro fails
      return callFlashVisionMulti(parts);
    }
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
  } catch (e) {
    console.warn('Pro vision error:', e);
    return callFlashVisionMulti(parts);
  }
}

async function callFlashVisionMulti(parts) {
  try {
    const res = await fetch(FLASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
      }),
    });
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
  } catch { return '{}'; }
}
