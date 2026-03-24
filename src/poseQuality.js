// ─── Pose Quality Checker ─────────────────────────────────────────────────────
// MediaPipe is used ONLY to decide when the pose is good enough to capture.
// It does NOT do measurements — that's Gemini's job.

export const LM = {
  NOSE:0, LEFT_SHOULDER:11, RIGHT_SHOULDER:12,
  LEFT_HIP:23, RIGHT_HIP:24,
  LEFT_ANKLE:27, RIGHT_ANKLE:28,
};

// Returns 0–100 score + whether the pose is ready to capture
export function scorePose(lm, canvasW, canvasH, angle) {
  if (!lm || !lm.length) return { score: 0, ready: false, issue: 'no_person' };

  const need = angle === 'front' || angle === 'back'
    ? [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_ANKLE, LM.RIGHT_ANKLE]
    : [LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_ANKLE];

  const visible = need.every(i => (lm[i]?.visibility || 0) > 0.45);
  if (!visible) return { score: 0, ready: false, issue: 'full_body' };

  let score = 35;

  // Body fills frame vertically (head to ankle)
  const nose = lm[LM.NOSE];
  const la = lm[LM.LEFT_ANKLE], ra = lm[LM.RIGHT_ANKLE];
  const footY = ((la?.y || 0) + (ra?.y || 0)) / 2;
  const bodyH = Math.abs(footY - (nose?.y || 0));

  if (bodyH > 0.76) score += 25;
  else if (bodyH > 0.58) score += 13;
  else if (bodyH < 0.42) return { score: 10, ready: false, issue: 'too_far' };
  else return { score: 18, ready: false, issue: 'full_body' };

  // Horizontal centering
  const ls = lm[LM.LEFT_SHOULDER], rs = lm[LM.RIGHT_SHOULDER];
  const lh = lm[LM.LEFT_HIP], rh = lm[LM.RIGHT_HIP];
  const midX = ((ls?.x||.5)+(rs?.x||.5)+(lh?.x||.5)+(rh?.x||.5)) / 4;
  if (Math.abs(midX - 0.5) < 0.09) score += 20;
  else if (Math.abs(midX - 0.5) < 0.17) score += 10;
  else return { score: 25, ready: false, issue: midX < 0.5 ? 'move_right' : 'move_left' };

  // Shoulder level (front/back only)
  if (angle === 'front' || angle === 'back') {
    const tilt = Math.abs((ls?.y||0) - (rs?.y||0));
    if (tilt < 0.035) score += 20;
    else if (tilt < 0.08) score += 10;
    else score += 0;
  } else {
    score += 20;
  }

  const ready = score >= 80;
  return { score, ready, issue: ready ? null : 'hold_still' };
}

export function drawSkeleton(ctx, lm, W, H, mirrored) {
  if (!lm) return;
  const pairs = [
    [11,12],[11,13],[13,15],[12,14],[14,16],
    [11,23],[12,24],[23,24],
    [23,25],[25,27],[24,26],[26,28],
  ];
  const pt = i => ({
    x: (mirrored ? 1 - lm[i].x : lm[i].x) * W,
    y: lm[i].y * H,
  });
  ctx.strokeStyle = 'rgba(255,215,0,0.5)';
  ctx.lineWidth = 2.5;
  pairs.forEach(([a, b]) => {
    if ((lm[a]?.visibility||0) > 0.4 && (lm[b]?.visibility||0) > 0.4) {
      ctx.beginPath(); ctx.moveTo(pt(a).x, pt(a).y); ctx.lineTo(pt(b).x, pt(b).y); ctx.stroke();
    }
  });
  ctx.fillStyle = '#FF6B35';
  Object.values(LM).forEach(i => {
    if ((lm[i]?.visibility||0) > 0.4) {
      ctx.beginPath(); ctx.arc(pt(i).x, pt(i).y, 4, 0, 2*Math.PI); ctx.fill();
    }
  });
}
