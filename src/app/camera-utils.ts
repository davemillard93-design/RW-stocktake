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
  return canvas.getContext("2d")?.getImageData(0, 0, 24, 42).data || null;
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
