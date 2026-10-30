import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElectricReference, INPUT_STRIDE, MAX_FRAMES, MAX_VOICES } from "../../src/reference.ts";
import { electricProfileValues, validateElectricProfile } from "../../src/profile.ts";

const mini = { radiusM: 0.0597, blades: 2, chordM: 0.011, pitchM: 0.06604, maxRpm: 13300,
  referenceThrustN: 0.6106725, tonalGain: 0.22, broadbandGain: 0.14, mechanicalGain: 0.035, outputGain: 0.8 };
const air = { radiusM: 0.0917, blades: 2, chordM: 0.0155, pitchM: 0.09652, maxRpm: 9200,
  referenceThrustN: 1.4592375, tonalGain: 0.24, broadbandGain: 0.18, mechanicalGain: 0.03, outputGain: 0.9 };
const module = new WebAssembly.Module(readFileSync(new URL("../single/electric-sound.wasm", import.meta.url)));
interface VoiceExports {
  memory: WebAssembly.Memory;
  osfs_voice_abi_version(): number;
  osfs_voice_init(rate: number, block: number, seed: number, count: number): number;
  osfs_voice_reset(): void;
  osfs_voice_input_ptr(): number;
  osfs_voice_output_ptr(): number;
  osfs_voice_profile_ptr(index: number): number;
  osfs_voice_profile_size(): number;
  osfs_voice_commit_profile(index: number): number;
  osfs_voice_process(frames: number): number;
}
function create(rate = 48000, count = 1, profile = mini, seed = 0x53463530) {
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as VoiceExports;
  assert.equal(exports.osfs_voice_abi_version(), 1);
  assert.equal(exports.osfs_voice_init(rate, MAX_FRAMES, seed, count), 1);
  const reference = createElectricReference(rate, count, seed);
  for (let v = 0; v < count; v++) {
    new Float64Array(exports.memory.buffer, exports.osfs_voice_profile_ptr(v), 10).set(electricProfileValues(profile));
    assert.equal(exports.osfs_voice_commit_profile(v), 1);
    reference.configure(v, profile);
  }
  const input = new Float64Array(exports.memory.buffer, exports.osfs_voice_input_ptr(), MAX_VOICES * MAX_FRAMES * INPUT_STRIDE);
  const output = new Float64Array(exports.memory.buffer, exports.osfs_voice_output_ptr(), MAX_VOICES * MAX_FRAMES * 2);
  function fill(rpm = 6000, thrust = profile.referenceThrustN) {
    for (let v = 0; v < count; v++) for (let frame = 0; frame < MAX_FRAMES; frame++) {
      const offset = (v * MAX_FRAMES + frame) * INPUT_STRIDE;
      input.set([rpm, thrust, 0.003, 3, 0, 1.225, 0, 1, 2, 8, 2], offset + 16);
      input[offset + 13] = 1;
      input[offset + 30] = 1;
      input[offset + 31] = v === 0 ? 1 : 0;
    }
  }
  fill();
  return { exports, reference, input, output, fill,
    process(frames = 128) { assert.equal(exports.osfs_voice_process(frames), 1); return output; } };
}
const rms = (samples: ArrayLike<number>) => Math.sqrt(Array.from(samples).reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
function render(profile = mini, rpm = 6000, rate = 48000, thrust = profile.referenceThrustN, seconds = 0.25) {
  const core = create(rate, 1, profile);
  core.fill(rpm, thrust);
  const samples: number[] = [];
  for (let i = 0; i < Math.ceil(rate * seconds / 128); i++) samples.push(...core.process().slice(0, 128));
  return samples;
}
function amplitude(samples: readonly number[], frequency: number, rate: number) {
  let real = 0; let imag = 0;
  for (let i = 0; i < samples.length; i++) {
    real += samples[i] * Math.cos(2 * Math.PI * frequency * i / rate);
    imag += samples[i] * Math.sin(2 * Math.PI * frequency * i / rate);
  }
  return Math.hypot(real, imag) / samples.length;
}

test("voice module is sandboxed and rejects invalid initialization/profiles/blocks", () => {
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const core = create();
  assert.equal(core.exports.osfs_voice_init(NaN, 128, 1, 1), 0);
  assert.equal(core.exports.osfs_voice_init(48000, 1025, 1, 1), 0);
  assert.equal(core.exports.osfs_voice_init(48000, 128, 1, 5), 0);
  assert.equal(core.exports.osfs_voice_process(1025), 0);
  assert.equal(core.exports.osfs_voice_profile_ptr(-1), 0);
  const setup = new Float64Array(core.exports.memory.buffer, core.exports.osfs_voice_profile_ptr(0), 10);
  for (const invalid of [NaN, -1, Infinity, 0]) {
    setup[0] = invalid;
    assert.equal(core.exports.osfs_voice_commit_profile(0), 0);
    assert.throws(() => validateElectricProfile({ ...mini, radiusM: invalid }));
  }
  assert.throws(() => validateElectricProfile({ ...mini, blades: 1.5 }));
  assert.throws(() => validateElectricProfile({ ...mini, tonalGain: 17 }));
});

test("Rust/WASM matches TypeScript sample-for-sample across rates, sources, tiers and in-block resets", () => {
  for (const rate of [44100, 48000]) {
    const core = create(rate, 4, rate === 44100 ? air : mini);
    const memory = core.exports.memory.buffer;
    for (let block = 0; block < 12; block++) {
      for (let v = 0; v < 4; v++) for (let frame = 0; frame < 256; frame++) {
        const o = (v * MAX_FRAMES + frame) * INPUT_STRIDE;
        core.input[o + 16] = 2800 + v * 1700 + block * 250 + frame * 0.3;
        core.input[o + 17] = 0.2 + v * 0.3 + block * 0.02;
        core.input[o + 18] = 0.001 + block * 0.0002;
        core.input[o + 19] = block * 0.2;
        core.input[o + 20] = block / 12;
        core.input[o + 22] = -block;
        core.input[o + 24] = block === 4 ? 0 : (block % 3) + 1;
        core.input[o + 25] = 4 + (block % 3) * 4;
        core.input[o + 26] = block % 4;
        core.input[o + 29] = block > 5 || (block === 5 && frame >= 80) ? 1 : 0;
        core.input[o + 30] = block === 7 && frame > 20 ? 0 : 1;
      }
      const reference = core.reference.process(core.input, 256);
      const actual = core.process(256);
      for (let v = 0; v < 4; v++) for (let bus = 0; bus < 2; bus++) for (let frame = 0; frame < 256; frame++) {
        const i = (v * 2 + bus) * MAX_FRAMES + frame;
        assert.equal(actual[i], reference[i], `rate ${rate}, block ${block}, voice ${v}, bus ${bus}, frame ${frame}`);
      }
    }
    assert.equal(core.exports.memory.buffer, memory, "render cannot grow memory");
  }
});

test("four independent rotors respond only to their own speed and load", () => {
  const baseline = create(48000, 4);
  const changed = create(48000, 4);
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const o = (MAX_FRAMES + frame) * INPUT_STRIDE;
    changed.input[o + 16] = 9000;
    changed.input[o + 17] = 1.2;
  }
  let changedRms = 0;
  for (let block = 0; block < 10; block++) {
    const a = baseline.process(); const b = changed.process();
    for (const v of [0, 2, 3]) assert.deepEqual(a.slice(v * 2048, v * 2048 + 128), b.slice(v * 2048, v * 2048 + 128));
    changedRms += rms(Array.from(a.slice(2048, 2176), (sample, i) => sample - b[2048 + i]));
  }
  assert.ok(changedRms > 0.01);
  assert.notDeepEqual(baseline.output.slice(0, 128), baseline.output.slice(4096, 4224), "same RPM does not phase-lock rotors");
});

test("one partial per rotor retains all four blade-passage fundamentals on Low", () => {
  const core = create(48000, 4, { ...mini, broadbandGain: 0, mechanicalGain: 1 });
  const signals: number[][] = [[], [], [], []];
  for (let v = 0; v < 4; v++) for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const offset = (v * MAX_FRAMES + frame) * INPUT_STRIDE;
    core.input[offset + 16] = 6000 + v * 600;
    core.input[offset + 24] = 1;
    core.input[offset + 25] = 1;
    core.input[offset + 26] = 0;
  }
  for (let block = 0; block < 100; block++) {
    const reference = core.reference.process(core.input, 128);
    const actual = core.process(128);
    for (let v = 0; v < 4; v++) {
      const start = v * 2 * MAX_FRAMES;
      assert.deepEqual(actual.slice(start, start + 128), reference.slice(start, start + 128));
      if (block >= 25) signals[v].push(...actual.slice(start, start + 128));
    }
  }
  for (let v = 0; v < 4; v++) {
    const fundamental = 200 + v * 20;
    assert.ok(amplitude(signals[v], fundamental, 48000) > 0.01);
    assert.ok(amplitude(signals[v], fundamental / 2, 48000) < 0.0001, "one partial prioritizes blade passage above mechanical shaft tone");
    assert.ok(amplitude(signals[v], fundamental * 2, 48000) < 0.0001, "one partial does not add higher harmonics");
  }
});

test("two-blade passage follows RPM, both drone profiles sound different, and load changes amplitude", () => {
  const tonal = { ...mini, broadbandGain: 0, mechanicalGain: 0 };
  const samples = render(tonal, 6000).slice(-4800);
  assert.ok(amplitude(samples, 200, 48000) > 0.01);
  assert.ok(amplitude(samples, 200, 48000) > amplitude(samples, 180, 48000) * 50);
  const faster = render(tonal, 9000).slice(-4800);
  assert.ok(amplitude(faster, 300, 48000) > amplitude(faster, 200, 48000) * 50);
  assert.notDeepEqual(render(mini).slice(-128), render(air).slice(-128));
  assert.ok(rms(render(mini, 6000, 48000, 0.9).slice(-4800)) > rms(render(mini, 6000, 48000, 0.1).slice(-4800)) * 1.5);
});

test("stopped rotors are silent, shutdown settles, and reset controls are sample accurate", () => {
  assert.equal(rms(render(mini, 0)), 0);
  const core = create();
  for (let i = 0; i < 20; i++) core.process();
  core.fill(0);
  for (let i = 0; i < 90; i++) core.process();
  assert.equal(rms(core.output.slice(0, 128)), 0);
  core.fill();
  core.exports.osfs_voice_reset();
  for (let frame = 64; frame < 128; frame++) core.input[frame * INPUT_STRIDE + 29] = 1;
  const out = core.process().slice(0, 128);
  assert.deepEqual(out.slice(0, 64), out.slice(64), "mid-block reset restarts the same profile and seed exactly");
});

test("invalid telemetry fades cached valid targets over 10 ms without an initial discontinuity", () => {
  const profile = { ...mini, broadbandGain: 0, mechanicalGain: 0 };
  const baseline = create(48000, 1, profile);
  const fading = create(48000, 1, profile);
  for (let block = 0; block < 20; block++) { baseline.process(); fading.process(); }
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const offset = frame * INPUT_STRIDE;
    fading.input[offset + 30] = 0;
    for (let field = 16; field <= 22; field++) fading.input[offset + field] = NaN;
  }
  let index = 0;
  for (let block = 0; block < 5; block++) {
    const a = baseline.process(); const b = fading.process();
    for (let frame = 0; frame < 128; frame++, index++) {
      const envelope = Math.max(0, 1 - (index + 1) / 480);
      assert.ok(Math.abs(b[frame] - a[frame] * envelope) < 1e-14, `10 ms linear fade sample ${index}`);
    }
  }
  assert.equal(rms(fading.output.slice(0, 128)), 0);
  const neverValid = create();
  for (let frame = 0; frame < MAX_FRAMES; frame++) neverValid.input[frame * INPUT_STRIDE + 30] = 0;
  assert.equal(rms(neverValid.process().slice(0, 128)), 0, "missing initial feed cannot create a cached voice");
});

test("alias culling and malformed live values remain finite at every tier", () => {
  const high = { ...mini, blades: 16, maxRpm: 100000, mechanicalGain: 0, broadbandGain: 0 };
  assert.equal(rms(render(high, 100000, 44100).slice(-4410)), 0);
  for (const rate of [44100, 48000]) for (const tier of [1, 2, 3]) {
    const core = create(rate, 4);
    for (let v = 0; v < 4; v++) for (let frame = 0; frame < 128; frame++) {
      const o = (v * MAX_FRAMES + frame) * INPUT_STRIDE;
      core.input[o + 24] = tier;
      for (const field of [16, 17, 18, 19, 20, 21, 22]) core.input[o + field] = frame % 2 ? NaN : Infinity;
    }
    assert.ok(core.process().every(Number.isFinite));
  }
});
