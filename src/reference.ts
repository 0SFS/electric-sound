import { VOICE_INPUT_FIELDS, VOICE_MAX_FRAMES, VOICE_MAX_SOURCES } from "../../engine-sound/src/voiceAbi.ts";
import { electricProfileValues } from "./profile.ts";

export const MAX_VOICES = VOICE_MAX_SOURCES;
export const MAX_FRAMES = VOICE_MAX_FRAMES;
export const INPUT_STRIDE = VOICE_INPUT_FIELDS.length;
const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const UINT = 4294967296;
const CONTROL_STRIDE = 8;

const HARMONIC_WEIGHTS = [0, 1, 0.30, -0.12, 0.06, -0.032] as const;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;

/** Polynomial sine avoids host math imports and keeps the two implementations identical. */
function sine(phase: number): number {
  const quadrant = (phase - Math.floor(phase)) * 4;
  const folded = quadrant <= 1 ? quadrant : quadrant <= 3 ? 2 - quadrant : quadrant - 4;
  const x = folded * HALF_PI;
  const square = x * x;
  return x * (1 + square * (-0.16666666666666666 + square * (0.008333333333333333
    + square * (-0.0001984126984126984 + square * (0.0000027557319223985893
    + square * -0.00000002505210838544172)))));
}

interface Voice {
  profile: number[];
  rng: number;
  seed: number;
  phase: number;
  modulation: number;
  smooth: Float64Array;
  targets: Float64Array;
  gate: number;
  density: number;
  low: number;
  high: number;
  wash: number;
  counter: number;
  controlCountdown: number;
  lastPartials: number;
  activeHarmonics: number;
  anti1: number;
  hWeight: Float64Array;
  tonalScale: number;
  shaftScale: number;
  highAlpha: number;
  lowAlpha: number;
  broadbandScale: number;
  bladeModDepth: number;
  vrsModDepth: number;
  wakeScale: number;
}

/** Numeric reference. The production host runs the Rust twin in its AudioWorklet. */
export function createElectricReference(sampleRate: number, voiceCount: number, seed = 0x53463530) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || !Number.isInteger(voiceCount) || voiceCount < 1 || voiceCount > MAX_VOICES) throw new Error("Invalid electric renderer initialization");
  const output = new Float64Array(MAX_VOICES * 2 * MAX_FRAMES);
  const voices: Voice[] = Array.from({ length: voiceCount }, (_, index) => {
    const ownSeed = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    const validSeed = ownSeed || 1;
    return {
      profile: [],
      rng: validSeed,
      seed: validSeed,
      phase: validSeed / UINT,
      modulation: validSeed / UINT,
      smooth: new Float64Array(6),
      targets: new Float64Array(6),
      gate: 0,
      density: 1.225,
      low: 0,
      high: 0,
      wash: 0,
      counter: 0,
      controlCountdown: 0,
      lastPartials: -1,
      activeHarmonics: 0,
      anti1: 0,
      hWeight: new Float64Array(6),
      tonalScale: 0,
      shaftScale: 0,
      highAlpha: 0,
      lowAlpha: 0,
      broadbandScale: 0,
      bladeModDepth: 0,
      vrsModDepth: 0,
      wakeScale: 0,
    };
  });
  function resetVoice(voice: Voice) {
    voice.rng = voice.seed;
    voice.phase = voice.seed / UINT;
    voice.modulation = voice.seed / UINT;
    voice.smooth.fill(0);
    voice.targets.fill(0);
    voice.gate = 0;
    voice.density = 1.225;
    voice.low = voice.high = voice.wash = 0;
    voice.counter = 0;
    voice.controlCountdown = 0;
    voice.lastPartials = -1;
    voice.activeHarmonics = 0;
    voice.anti1 = 0;
    voice.hWeight.fill(0);
    voice.tonalScale = 0;
    voice.shaftScale = 0;
    voice.highAlpha = 0;
    voice.lowAlpha = 0;
    voice.broadbandScale = 0;
    voice.bladeModDepth = 0;
    voice.vrsModDepth = 0;
    voice.wakeScale = 0;
  }
  function random(voice: Voice): number {
    let x = voice.rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    voice.rng = x >>> 0;
    return voice.rng / 2147483648 - 1;
  }
  const alpha = 1 / (1 + sampleRate * 0.01);
  const gateStep = 1 / (sampleRate * 0.01);
  const invRate = 1 / sampleRate;
  const nyquistLimit = sampleRate * 0.48;
  const invFadeBw = 1 / (sampleRate * 0.08);
  return {
    output,
    configure(index: number, profile: unknown) {
      if (!voices[index]) throw new Error("Invalid electric voice index");
      voices[index].profile = electricProfileValues(profile);
      resetVoice(voices[index]);
    },
    reset() { for (const voice of voices) resetVoice(voice); output.fill(0); },
    process(input: Float64Array, frames: number): Float64Array {
      if (!Number.isInteger(frames) || frames < 0 || frames > MAX_FRAMES
        || input.length < voiceCount * MAX_FRAMES * INPUT_STRIDE) throw new Error("Invalid electric render buffer");
      for (let v = 0; v < voiceCount; v++) {
        const voice = voices[v];
        if (!voice.profile.length) throw new Error("Electric voice has no profile");
        const [radius, blades, chord, pitch, maxRpm, referenceThrust, tonalGain, broadbandGain, mechanicalGain, outputGain] = voice.profile;
        const invMaxRpm = 1 / maxRpm;
        const invRefThrust = 1 / referenceThrust;
        const invRefTorque = 1 / (referenceThrust * radius * 0.08);
        const pitchSlope = pitch / (TAU * radius) * 0.15;
        const geometry = Math.sqrt(clamp(chord * radius / 0.001, 0.05, 30));
        for (let frame = 0; frame < frames; frame++) {
          const offset = (v * MAX_FRAMES + frame) * INPUT_STRIDE;
          const sourceOutput = v * 2 * MAX_FRAMES + frame;
          output[sourceOutput] = 0;
          output[sourceOutput + MAX_FRAMES] = 0;
          const counter = finite(input[offset + 29]);
          if (counter !== voice.counter) { resetVoice(voice); voice.counter = counter; }
          if (!(input[offset + 24] > 0)) continue;
          const valid = input[offset + 30] > 0.5;
          voice.gate = clamp(voice.gate + (valid ? gateStep : -gateStep), 0, 1);
          if (valid) {
            voice.targets[0] = clamp(finite(input[offset + 16]), 0, maxRpm * 2);
            voice.targets[1] = clamp(finite(input[offset + 17]), 0, referenceThrust * 8);
            voice.targets[2] = Math.abs(finite(input[offset + 18]));
            voice.targets[3] = Math.abs(finite(input[offset + 19]));
            voice.targets[4] = clamp(finite(input[offset + 20]), 0, 1);
            voice.targets[5] = Math.abs(finite(input[offset + 22]));
            voice.density = clamp(finite(input[offset + 21], 1.225), 0.1, 3);
          }
          if (voice.gate === 0) continue;
          const targets = voice.targets;
          for (let i = 0; i < 6; i++) voice.smooth[i] += alpha * (targets[i] - voice.smooth[i]);
          if (targets[0] === 0 && voice.smooth[0] < 0.1) voice.smooth[0] = 0;
          const [rpm, thrust, torque, induced, vrs, axial] = voice.smooth;
          const rotationHz = rpm / 60;
          voice.phase += rotationHz * invRate;
          voice.phase -= Math.floor(voice.phase);
          voice.modulation += rotationHz * 0.09 * invRate;
          voice.modulation -= Math.floor(voice.modulation);
          if (rpm === 0) {
            voice.controlCountdown = 0;
            continue;
          }
          const partials = Math.floor(clamp(finite(input[offset + 25]), 0, 12));
          const noiseBands = Math.floor(clamp(finite(input[offset + 26]), 0, 8));
          const bladePhase = voice.phase * blades;
          const bladeSin = sine(bladePhase);

          if (voice.controlCountdown === 0 || partials !== voice.lastPartials) {
            voice.controlCountdown = CONTROL_STRIDE;
            voice.lastPartials = partials;
            const speed = rpm * invMaxRpm;
            const tip = TAU * radius * rotationHz;
            const tipScale = clamp(tip / 80, 0, 3);
            const load = clamp(thrust * invRefThrust, 0, 4);
            const loadSqrt = Math.sqrt(load);
            const torqueLoad = clamp(torque * invRefTorque, 0, 4);
            const density = voice.density / 1.225;
            const cull = clamp(finite(input[offset + 13], 1), 0.5, 2);
            const cosine = clamp(finite(input[offset + 14], 0), -1, 1);
            const dirWeight = clamp(finite(input[offset + 15], 0), 0, 1);
            const inPlane = 1 - Math.abs(cosine);
            const highFidelity = input[offset + 28] > 0.5;
            let harmonics = 0;
            if (partials === 1) {
              harmonics = 3;
            } else if (partials > 1) {
              harmonics = highFidelity ? 5 : 4;
            }
            const bpfHz = rotationHz * blades;
            if (harmonics > 0 && bpfHz * cull < nyquistLimit) {
              voice.anti1 = clamp((nyquistLimit - bpfHz * cull) * invFadeBw, 0, 1);
              const directivityBright = 1 + dirWeight * (0.25 * inPlane - 0.08);
              let maxH = 1;
              for (let harmonic = 2; harmonic <= harmonics; harmonic++) {
                const frequency = bpfHz * harmonic;
                if (frequency * cull >= nyquistLimit) break;
                maxH = harmonic;
                const antiAlias = clamp((nyquistLimit - frequency * cull) * invFadeBw, 0, 1);
                voice.hWeight[harmonic] = (1 + pitchSlope * (harmonic - 1))
                  * directivityBright
                  * HARMONIC_WEIGHTS[harmonic]
                  * antiAlias;
              }
              voice.activeHarmonics = maxH;
            } else {
              voice.activeHarmonics = 0;
              voice.anti1 = 0;
            }
            const tonalEnvelope = speed * speed * (0.2 + 0.8 * loadSqrt) * (0.5 + 0.5 * tipScale);
            voice.tonalScale = tonalGain * tonalEnvelope;
            if (partials > 1) {
              const shaftAnti = clamp((nyquistLimit - rotationHz * cull) * invFadeBw, 0, 1);
              voice.shaftScale = mechanicalGain * speed * (0.2 + 0.8 * Math.sqrt(torqueLoad)) * shaftAnti;
            } else {
              voice.shaftScale = 0;
            }
            const highCut = clamp(650 + tip * 32 + (induced + axial) * 42, 20, sampleRate * 0.38);
            const lowCut = clamp(150 + tip * 3, 20, highCut * 0.6);
            const highOmega = TAU * highCut;
            const lowOmega = TAU * lowCut;
            voice.highAlpha = highOmega / (sampleRate + highOmega);
            voice.lowAlpha = lowOmega / (sampleRate + lowOmega);
            const broadbandEnvelope = tipScale * tipScale * (0.25 + 0.75 * load) * geometry * density;
            const lowTierTrim = partials === 1 ? 0.82 : 1;
            voice.broadbandScale = broadbandGain * broadbandEnvelope * (1 + vrs * 0.8) * lowTierTrim;
            voice.bladeModDepth = 0.22 + 0.1 * loadSqrt;
            voice.vrsModDepth = vrs * 0.2;
            voice.wakeScale = broadbandGain * speed * load * (0.2 + vrs * 0.6);
          }
          voice.controlCountdown -= 1;

          let tone = 0;
          if (voice.activeHarmonics > 0) {
            tone = bladeSin * voice.anti1;
            if (voice.activeHarmonics > 1) {
              const c1 = sine(bladePhase + 0.25);
              const twoC1 = 2 * c1;
              let sPrev = 0;
              let sCurr = bladeSin;
              for (let harmonic = 2; harmonic <= voice.activeHarmonics; harmonic++) {
                const sNext = twoC1 * sCurr - sPrev;
                sPrev = sCurr;
                sCurr = sNext;
                tone += sNext * voice.hWeight[harmonic];
              }
            }
          }
          let result = tone * voice.tonalScale;
          if (partials > 1) {
            result += sine(voice.phase) * voice.shaftScale;
          }
          if (noiseBands > 0) {
            const noise = random(voice);
            voice.high += voice.highAlpha * (noise - voice.high);
            voice.low += voice.lowAlpha * (noise - voice.low);
            const modulation = 1 + voice.bladeModDepth * bladeSin + voice.vrsModDepth * sine(voice.modulation);
            result += (voice.high - voice.low) * voice.broadbandScale * modulation;
            if (noiseBands > 1) {
              voice.wash += 0.02 * (random(voice) - voice.wash);
              result += voice.wash * voice.wakeScale;
            }
          }
          output[sourceOutput] = finite(result * outputGain * voice.gate);
        }
      }
      return output;
    },
  };
}
