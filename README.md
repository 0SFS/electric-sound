# Electric sound

Reusable procedural electric motor and propeller sound. One independent Rust/WASM
module implements `osfs-engine-voice-v1`, with a TypeScript reference beside it.
The owning engine mod supplies propeller geometry, speed range and acoustic
calibration. There are no aircraft identities or recordings in this generator.

Four independently phased rotor voices follow live RPM, load and listener
directivity. Blade-passage harmonics use a Chebyshev trigonometric recurrence
(`s_next = 2 * c1 * s_curr - s_prev`, synthesizing 3 harmonics per rotor on Low,
4 on Medium and 5 on High from two polynomial evaluations per sample) with
Schroeder-style phase dispersion (`[1.0, 0.30, -0.12, 0.06, -0.032]`) to keep
waveform crest factor and sample-to-sample slope low. Medium and High add the
$1\times$ shaft mechanical tone, and all tiers shape broadband trailing-edge/vortex
air rush through a tip-speed bandpass modulated at the blade-passage frequency
(`1 + blade_mod_depth * blade_sin + vrs_mod_depth * mod_sin`). Slow-moving
envelope, square-root, filter-coefficient and harmonic-weight calculations run at
an 8-sample control stride (`CONTROL_STRIDE = 8`). Gains and spectra are original
approximations, not measured acoustic calibration.

## ABI

`engine-sound` owns `osfs-engine-voice-v1`. The module has four source slots and
1,024 frames per block. Each source has 32 Float64 input fields per frame.
Outputs are Float64 planes: `(voice * 2 + bus) * 1024 + frame`; bus 0 is source
audio and bus 1 is zero (airframe noise belongs to the shared aircraft host).
Configuration and initialization run before rendering. Rendering allocates no
memory, grows no memory and calls no host functions.
An invalid telemetry transition keeps the last valid rotor targets under a
10 ms linear fade, then becomes silent. An initially missing feed stays silent.

`electricProfileValues` encodes ten numbers: radius, blade count, chord, pitch,
maximum RPM, reference thrust, tonal gain, broadband gain, mechanical gain and
output gain. Geometry is resolved from the propulsion mod's physical data.

## Development

`npm run build:wasm` builds offline using installed pinned Rust and Binaryen,
then records source hashes, binary hash, imports and exports. `npm run check:wasm`
checks that receipt. `npm test` checks TS/WASM parity and acoustic behavior.

The host loads compiled bytes in its existing AudioWorklet, supplies per-source
poses and performs propagation, spatialization, mixing and final limiting once.
This package owns no AudioContext, panels or user settings.

## Listening references

From a workspace containing the two drone and propulsion mods, `npm run references`
creates six 6-second stereo WAVs in `build/references/`: idle, hover and a speed
ramp for each drone. They use the current manifest geometry and rotor-plant
thrust/torque/inflow traces at 120 Hz, rendered by the shipped electric WASM at
48 kHz. Each fixture spins down after five seconds. Hover is about 8,994 RPM for
the Mini 2 and 6,243 RPM for the Air 2S with the current mass and air density.

The accompanying `.trace.json` files identify every input and the physical
propeller configuration. These are driven rotor-plant fixtures; rigid-body
flight motion is not integrated. They are procedural listening references,
not recordings or calibrated sound-pressure measurements. Medium uses twelve
partials and six noise bands across the four rotors, with one common fixed
mix gain and no automatic normalization, so the hardware profiles can be compared.

Topics: `0sfs-mod` and `0sfs-component-mod`. [Modding guide](https://github.com/0SFS/docs/blob/main/modding.md) describes discovery and installation.
