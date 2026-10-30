// Workspace listening fixtures: actual multirotor plant outputs with the
// installed propulsion geometry. These are procedural references, not aircraft
// recordings or a claim of acoustic calibration. Output stays in ignored build/.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { electricProfileValues } from "../src/profile.ts";

// The shared numeric kernels use bundler-style extensionless TS imports.
// Resolve those only for this offline fixture generator; ship no loader code.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && /^(?:\.\/|\.\.\/)/.test(specifier)
      && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { createAirframe } = await import("../../multirotor/src/airframe.ts");
const { createMultirotor } = await import("../../multirotor/src/multirotor.ts");
const { PLANT } = await import("../../multirotor/src/layout.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = path.dirname(root);
const destination = path.join(root, "build/references");
mkdirSync(destination, { recursive: true });
const module = new WebAssembly.Module(readFileSync(path.join(root, "wasm/single/electric-sound.wasm")));
const rate = 48000;
const seconds = 6;
const stepHz = 120;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const results = [];

function wave(left, right) {
  const frames = left.length;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buffer.writeInt16LE(Math.round(clamp(left[i], -1, 1) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(clamp(right[i], -1, 1) * 32767), 46 + i * 4);
  }
  return buffer;
}

for (const [repo, aircraftId] of [["DJI-Mini2", "dji-mini2"], ["DJI-Air-2S", "dji-air2s"]]) {
  const aircraft = JSON.parse(readFileSync(path.join(workspace, repo, "public/0sfs-mod.json")));
  const engine = JSON.parse(readFileSync(path.join(workspace, `${repo}-propulsion/public/0sfs-mod.json`))).engine;
  const propeller = engine.electric.propeller;
  const profile = electricProfileValues({ ...propeller, ...engine.acousticProfile.parameters });
  const xml = readFileSync(path.join(workspace, repo, `public/jsbsim-data/aircraft/${aircraftId}/${aircraftId}.xml`), "utf8");
  const massKg = Number(xml.match(/<emptywt unit="LBS">([^<]+)<\/emptywt>/)?.[1]) * 0.45359237;
  if (!(massKg > 0)) throw new Error(`Missing mass for ${repo}`);
  const airframe = createAirframe({ ...aircraft.quad, propeller }, 1 / stepHz);
  const hover = airframe.hoverOmega(massKg, 1.225);
  for (const scenario of ["idle", "hover", "ramp"]) {
    const plant = createMultirotor(airframe);
    const input = plant.plant.input;
    input[PLANT.input.RHO] = 1.225;
    input[PLANT.input.C33] = 1;
    input[PLANT.input.AGL] = 2;
    const trace = [];
    for (let step = 0; step < seconds * stepHz; step++) {
      const time = step / stepHz;
      const target = time >= 5 ? 0 : scenario === "idle" ? airframe.omegaIdle : scenario === "hover" ? hover
        : airframe.omegaIdle + (hover * 1.25 - airframe.omegaIdle) * clamp(time / 4, 0, 1);
      for (let v = 0; v < 4; v++) input[PLANT.input.globals + v] = Math.min(airframe.omegaMax,
        target * (scenario === "ramp" && time < 5 ? 1 + aircraft.quad.rotors[v].spin * 0.04 * Math.sin(time * 3) : 1));
      plant.runPlant();
      const output = plant.plant.output;
      trace.push({ simTimeS: time, rho: 1.225, rotors: Array.from({ length: 4 }, (_, v) => {
        const o = PLANT.output.globals + v * PLANT.output.stride;
        return { rpm: output[o + PLANT.output.OMEGA] * 30 / Math.PI, thrustN: output[o + PLANT.output.THRUST],
          torqueNm: output[o + PLANT.output.TORQUE], inducedVelocityMps: output[o + PLANT.output.INDUCED],
          vrs: output[o + PLANT.output.VRS] };
      }) });
    }
    plant.dispose();
    const core = new WebAssembly.Instance(module, {}).exports;
    if (!core.osfs_voice_init(rate, 1024, 0x53463530, 4)) throw new Error("Electric init failed");
    for (let v = 0; v < 4; v++) {
      new Float64Array(core.memory.buffer, core.osfs_voice_profile_ptr(v), 10).set(profile);
      if (!core.osfs_voice_commit_profile(v)) throw new Error("Electric profile failed");
    }
    const params = new Float64Array(core.memory.buffer, core.osfs_voice_input_ptr(), 4 * 1024 * 32);
    const output = new Float64Array(core.memory.buffer, core.osfs_voice_output_ptr(), 4 * 2 * 1024);
    const left = new Float64Array(seconds * rate);
    const right = new Float64Array(left.length);
    let peak = 0;
    for (let base = 0; base < left.length; base += 128) {
      const count = Math.min(128, left.length - base);
      for (let v = 0; v < 4; v++) for (let frame = 0; frame < count; frame++) {
        const time = (base + frame) / rate;
        const step = Math.min(trace.length - 1, Math.floor(time * stepHz));
        const next = Math.min(trace.length - 1, step + 1);
        const blend = clamp(time * stepHz - step, 0, 1);
        const a = trace[step].rotors[v]; const b = trace[next].rotors[v];
        const fields = ["rpm", "thrustN", "torqueNm", "inducedVelocityMps", "vrs"];
        const o = (v * 1024 + frame) * 32;
        for (let i = 0; i < fields.length; i++) params[o + 16 + i] = a[fields[i]] + (b[fields[i]] - a[fields[i]]) * blend;
        params[o + 13] = 1; params[o + 21] = 1.225; params[o + 23] = time < 5 ? 1 : 0;
        // Match the host Medium installation budget: 12 partials and 6 noise bands total.
        params[o + 24] = 2; params[o + 25] = 3; params[o + 26] = v < 2 ? 2 : 1; params[o + 30] = 1;
      }
      if (!core.osfs_voice_process(count)) throw new Error("Electric render failed");
      for (let frame = 0; frame < count; frame++) {
        for (let v = 0; v < 4; v++) {
          const pan = clamp(aircraft.quad.rotors[v].hubM[1], -1, 1);
          const angle = (pan + 1) * Math.PI * 0.25;
          // Fixed 0.5 mix gain at a nominal one-metre exterior listening point.
          // No automatic normalization: compare both hardware profiles directly.
          const mono = output[v * 2048 + frame] * 0.5;
          left[base + frame] += mono * Math.cos(angle);
          right[base + frame] += mono * Math.sin(angle);
        }
        peak = Math.max(peak, Math.abs(left[base + frame]), Math.abs(right[base + frame]));
      }
    }
    const name = `${aircraftId}-${scenario}`;
    writeFileSync(path.join(destination, `${name}.wav`), wave(left, right));
    writeFileSync(path.join(destination, `${name}.trace.json`), JSON.stringify({
      source: "@0sfs/multirotor rotor plant, workspace physical manifests", scenario,
      limitations: "Driven rotor-speed fixture, no rigid-body flight integration; uncalibrated procedural acoustic output.",
      massKg, propeller, hoverRpm: hover * 30 / Math.PI, samples: trace,
    }));
    results.push({ name, peak, clipped: peak > 1, seconds, sampleRate: rate, hoverRpm: hover * 30 / Math.PI });
  }
}
writeFileSync(path.join(destination, "index.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ directory: destination, results }));
