// ─── Gemini Client ────────────────────────────────────────────────────────────
// Gemini does TWO jobs here:
// 1. VISION: Analyses body photos → extracts measurements from silhouette
// 2. GUIDE:  Converses naturally with the customer in their language

const KEY = import.meta.env.VITE_GEMINI_API_KEY;
const VISION_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEY}`;
const TEXT_URL   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${KEY}`;

export const geminiEnabled = () => !!KEY && KEY !== 'paste_your_gemini_key_here';

// ─── Convert canvas/video frame to base64 JPEG ───────────────────────────────
export function frameToBase64(canvas) {
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// ─── STEP 1: Clothing check ───────────────────────────────────────────────────
// Gemini looks at the first photo and checks if clothing is suitable
export async function checkClothing(base64img, lang) {
  const langNote = lang === 'ml'
    ? 'Reply in Malayalam (മലയാളം). Keep it conversational and warm.'
    : 'Reply in English. Keep it conversational and warm.';

  const prompt = `You are TailorBee's AI measurement assistant helping a customer in India.
${langNote}

Look at this photo. Determine if the person is wearing clothing suitable for body measurements.

SUITABLE: Fitted t-shirt, leggings, churidar, fitted kurta, sportswear — anything that shows body shape.
NOT SUITABLE: Loose nighty, baggy salwar, oversized t-shirt, thick dupatta, heavy saree drape, loose gown, blanket/shawl.

If NOT suitable: Speak warmly and explain why, suggest what to wear instead. Keep it to 2–3 sentences like a friendly tailor would say.
If suitable: Just say "looks good, let's begin" style message in 1 sentence.
If no person visible: Ask them to step in front of the camera.

Respond with ONLY the spoken message — no labels, no JSON, just what you'd say out loud.`;

  return callVision(prompt, base64img);
}

// ─── STEP 2: Angle verification ──────────────────────────────────────────────
// Gemini looks at the photo and confirms if the person has actually turned
// Returns { verified: bool, message: string }
export async function verifyAngle(base64img, expectedAngle, lang) {
  const langNote = lang === 'ml'
    ? 'Reply in Malayalam (മലയാളം).'
    : 'Reply in English.';

  const angleDescriptions = {
    front: 'facing directly towards the camera — we should see their face clearly',
    right: 'with their RIGHT side facing the camera — we should see their right shoulder and right hip clearly, face in profile',
    back:  'with their BACK to the camera — we should NOT see their face',
    left:  'with their LEFT side facing the camera — we should see their left shoulder and left hip clearly, face in profile',
  };

  const prompt = `You are TailorBee's measurement assistant.
${langNote}

I need to capture the person's body from the ${expectedAngle} angle (${angleDescriptions[expectedAngle]}).

Look at this photo and determine:
1. Is the person positioned correctly for the ${expectedAngle} view?
2. Is their full body visible from head to feet?
3. Is the lighting/image quality acceptable?

Respond ONLY with valid JSON, nothing else:
{
  "verified": true or false,
  "quality": "good" or "acceptable" or "poor",
  "issue": "brief description of the main issue if not verified, or null if verified",
  "message": "What you would say out loud to the customer — warm, helpful, specific. 1–2 sentences. ${lang === 'ml' ? 'In Malayalam' : 'In English'}."
}`;

  const raw = await callVision(prompt, base64img);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { verified: false, quality: 'poor', issue: 'Could not analyse photo', message: raw };
  }
}

// ─── STEP 3: Core measurement extraction ─────────────────────────────────────
// This is the main accuracy engine — Gemini Vision analyses all 4 photos
export async function extractMeasurements(photos, garmentLabel, garmentContext, heightCm, lang) {
  const langNote = lang === 'ml' ? 'Write the "analysis" field in Malayalam.' : 'Write the "analysis" field in English.';

  // Build multi-image prompt
  const prompt = `You are an expert body measurement AI for TailorBee, an Indian clothing service.
You are analysing 4 photos of the same person: front, right side, back, and left side views.
The person's height is ${heightCm} cm — use this to calibrate all pixel-to-cm conversions.
They need measurements for: ${garmentLabel} (${garmentContext})

MEASUREMENT METHOD:
- Use the person's known height (${heightCm} cm) to establish a pixel-per-cm scale
- For WIDTH measurements: measure the pixel width at each body zone in the front/back photos
- For DEPTH measurements: measure the pixel width at each body zone in the side photos  
- For CIRCUMFERENCE: use ellipse formula C = π × √(2(a²+b²)) where a=half-width, b=half-depth
- For LENGTH measurements: measure pixel distances along the body axis

CRITICAL RULES:
- Estimate conservatively — it's better to be 2cm loose than 2cm tight
- If a measurement is unclear due to clothing, add 2–3 cm to account for fabric
- Cross-check: bust should typically be larger than waist, hip ≥ bust for women
- Indian body proportions: average waist-to-hip ratio is 0.8–0.9 for women
- If you cannot see a body part clearly, note it in the analysis

${langNote}

Respond ONLY with valid JSON:
{
  "measurements": {
    "bust": number_in_cm_or_null,
    "waist": number_in_cm_or_null,
    "hip": number_in_cm_or_null,
    "shoulder_width": number_in_cm_or_null,
    "sleeve_length": number_in_cm_or_null,
    "garment_length": number_in_cm_or_null,
    "inseam": number_in_cm_or_null,
    "thigh": number_in_cm_or_null,
    "knee": number_in_cm_or_null,
    "calf": number_in_cm_or_null,
    "ankle": number_in_cm_or_null,
    "collar": number_in_cm_or_null,
    "under_bust": number_in_cm_or_null,
    "back_length": number_in_cm_or_null,
    "rise": number_in_cm_or_null
  },
  "confidence": {
    "bust": "high/medium/low",
    "waist": "high/medium/low",
    "hip": "high/medium/low"
  },
  "clothingNote": "brief note about clothing suitability impact, or null",
  "analysis": "2–3 sentence warm summary for the customer about their measurements and fit tips. Mention if any measurement had low confidence."
}`;

  // Call with all 4 images
  const parts = [{ text: prompt }];
  const angleLabels = ['Front view', 'Right side', 'Back view', 'Left side'];
  photos.forEach((b64, i) => {
    if (!b64) return;
    parts.push({ text: `\n${angleLabels[i]}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  });

  const raw = await callVisionMulti(parts);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { measurements: {}, analysis: raw, confidence: {} };
  }
}

// ─── STEP 4: Real-time pose guidance ─────────────────────────────────────────
// Gemini gives conversational feedback on the live camera frame
// Called sparingly (every ~4 seconds) to avoid API overuse
export async function getPoseGuidance(base64img, expectedAngle, previousIssue, lang) {
  const langNote = lang === 'ml'
    ? 'Reply in Malayalam (മലയാളം). Sound like a friendly shop assistant.'
    : 'Reply in English. Sound like a friendly shop assistant.';

  const angleInstructions = {
    front: 'standing straight, facing directly at the camera, arms slightly away from body, full body visible',
    right: 'turned so their right side faces the camera, standing straight, full body visible',
    back:  'turned with their back to the camera, standing straight, full body visible',
    left:  'turned so their left side faces the camera, standing straight, full body visible',
  };

  const prompt = `You are TailorBee's live measurement assistant.
${langNote}

The customer needs to be: ${angleInstructions[expectedAngle]}
Previous issue noted: ${previousIssue || 'none'}

Look at this camera frame and give ONE short, specific, helpful instruction (under 20 words).
Be like a real person helping them — notice exactly what's wrong and tell them specifically.

Examples of good responses:
- "Your arms are too close to your body — stretch them out just a little"
- "I can't see your feet — please step back about half a metre"  
- "You're almost there — just turn a tiny bit more to the right"
- "Perfect! Stay exactly like that"

Do NOT say generic things like "stand straight" unless that's really the issue.
Respond with ONLY the spoken instruction — nothing else.`;

  return callVision(prompt, base64img);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
async function callVision(prompt, base64img) {
  if (!geminiEnabled()) return fallback(prompt);
  try {
    const res = await fetch(VISION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64img } }
          ]
        }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
      }),
    });
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Ready when you are.';
  } catch (e) {
    console.warn('Gemini vision error:', e);
    return 'Ready when you are.';
  }
}

async function callVisionMulti(parts) {
  if (!geminiEnabled()) return '{"measurements":{}, "analysis":"Gemini API key not configured."}';
  try {
    const res = await fetch(VISION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
      }),
    });
    const d = await res.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
  } catch (e) {
    console.warn('Gemini multi-vision error:', e);
    return '{}';
  }
}

function fallback(prompt) {
  if (prompt.includes('clothing')) return "You look ready to go! Let's start measuring.";
  return "Please stand straight and face the camera.";
}
