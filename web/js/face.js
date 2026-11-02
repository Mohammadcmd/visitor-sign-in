// Camera and face recognition. Everything runs on the iPad: face-api.js turns a
// face into 128 numbers (a "descriptor"), and matching compares those numbers
// with the descriptors of visitors who opted into quick entry.
import { CONFIG } from '../config.js';

let stream = null;
let modelsReady = null;

export async function startCamera(video) {
  if (!stream || !stream.active) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
    });
  }
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  return video;
}

export function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

/** A JPEG of the current frame, at most maxSide px on the long side. */
export function snapshot(video, maxSide = 900, quality = 0.85) {
  const w = video.videoWidth, h = video.videoHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return { canvas, dataUrl: canvas.toDataURL('image/jpeg', quality) };
}

export function loadModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      const api = window.faceapi;
      if (!api) throw new Error('face-api.js did not load');
      const url = CONFIG.FACE_MODEL_URL;
      await Promise.all([
        api.nets.tinyFaceDetector.loadFromUri(url),
        api.nets.faceLandmark68Net.loadFromUri(url),
        api.nets.faceRecognitionNet.loadFromUri(url),
      ]);
    })();
    modelsReady.catch(() => { modelsReady = null; });
  }
  return modelsReady;
}

/** Descriptor for the single most prominent face, or null when no face is found. */
export async function describe(source) {
  await loadModels();
  const api = window.faceapi;
  const r = await api.detectSingleFace(source, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return r ? Array.from(r.descriptor) : null;
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

/** Best and runner-up people for one descriptor. */
function rank(descriptor, people) {
  return people.map((p) => ({
    person: p,
    d: Math.min(...p.descriptors.map((x) => distance(descriptor, x))),
  })).sort((x, y) => x.d - y.d);
}

/**
 * Decides who is in front of the camera from several frames' descriptors.
 * Returns the person only when it's sure: most frames agree, each agreeing frame
 * is close, and nobody else comes close. Anything less returns null.
 */
export function identify(descriptors, people) {
  if (!descriptors.length || !people.length) return null;
  const votes = new Map();
  for (const d of descriptors) {
    const [best, second] = rank(d, people);
    const margin = second ? second.d - best.d : Infinity;
    if (best.d <= CONFIG.FACE_MATCH_MAX && margin >= CONFIG.FACE_MATCH_MARGIN) {
      const v = votes.get(best.person.id) || { person: best.person, n: 0, d: 0 };
      v.n += 1;
      v.d += best.d;
      votes.set(best.person.id, v);
    }
  }
  const winner = [...votes.values()].sort((x, y) => y.n - x.n)[0];
  if (!winner || votes.size > 1 || winner.n < Math.ceil(descriptors.length / 2 + 0.01)) return null;
  return { person: winner.person, distance: winner.d / winner.n };
}

/** Average of several descriptors: a steadier sample to store. */
export function average(descriptors) {
  const out = new Array(128).fill(0);
  descriptors.forEach((d) => d.forEach((x, i) => { out[i] += x / descriptors.length; }));
  return out;
}
