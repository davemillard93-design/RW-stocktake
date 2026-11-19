export async function openPortraitCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Live camera access is unavailable. Open PourVentory in Safari over HTTPS.");
  }
  const preferred: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 720 },
      height: { ideal: 1280 },
      aspectRatio: { ideal: 9 / 16 },
      frameRate: { ideal: 24, max: 30 },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (error: any) {
    if (error?.name === "NotAllowedError" || error?.name === "NotFoundError") throw error;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
  }
}

/** Crops the live camera feed to the same narrow portrait window shown on screen. */
export function drawPortraitFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxHeight = 960,
): boolean {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  const aspect = 9 / 16;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (vw / vh > aspect) {
    sw = vh * aspect;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / aspect;
    sy = (vh - sh) / 2;
  }
  const outH = Math.min(maxHeight, Math.round(sh));
  const outW = Math.round(outH * aspect);
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
  return true;
}

export function portraitSignature(video: HTMLVideoElement): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 42;
  if (!drawPortraitFrame(video, canvas, 42)) return null;
  return portraitSignatureFromCanvas(canvas);
}

export function portraitSignatureFromCanvas(source: HTMLCanvasElement): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 42;
  const ctx = canvas.getContext("2d");
  if (!ctx || !source.width || !source.height) return null;
  ctx.drawImage(source, 0, 0, 24, 42);
  return ctx.getImageData(0, 0, 24, 42).data;
}

export function signatureDifference(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): number {
  if (!a || !b || a.length !== b.length) return 255;
  let total = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return total / count;
}

/** Estimates how much the camera moved between two portrait frames. */
export function estimatePortraitMotion(
  previous: Uint8ClampedArray | null,
  current: Uint8ClampedArray | null,
): { dx: number; dy: number } | null {
  const width = 24;
  const height = 42;
  if (!previous || !current || previous.length !== width * height * 4 || current.length !== previous.length) return null;

  const gray = (pixels: Uint8ClampedArray) => {
    const result = new Float32Array(width * height);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      result[p] = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }
    return result;
  };

  const a = gray(previous);
  const b = gray(current);
  const scoreAt = (dx: number, dy: number) => {
    const left = Math.max(0, -dx);
    const right = Math.min(width, width - dx);
    const top = Math.max(0, -dy);
    const bottom = Math.min(height, height - dy);
    const count = (right - left) * (bottom - top);
    if (count < width * height * 0.52) return Number.POSITIVE_INFINITY;

    let sumA = 0;
    let sumB = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        sumA += a[y * width + x];
        sumB += b[(y + dy) * width + x + dx];
      }
    }
    const meanA = sumA / count;
    const meanB = sumB / count;
    let error = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        error += Math.abs((a[y * width + x] - meanA) - (b[(y + dy) * width + x + dx] - meanB));
      }
    }
    return error / count;
  };

  const stillScore = scoreAt(0, 0);
  let best = { dx: 0, dy: 0, score: stillScore };
  for (let dy = -16; dy <= 16; dy++) {
    for (let dx = -12; dx <= 12; dx++) {
      if (dx === 0 && dy === 0) continue;
      const score = scoreAt(dx, dy);
      if (score < best.score) best = { dx, dy, score };
    }
  }

  // Ignore weak matches caused by lighting changes or a completely new view.
  if (!Number.isFinite(best.score) || stillScore - best.score < 2.5) return null;
  return { dx: best.dx * (1000 / width), dy: best.dy * (1000 / height) };
}

