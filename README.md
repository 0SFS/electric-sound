# Electric sound

Reusable procedural electric motor and propeller sound. One independent Rust/WASM
module implements `osfs-engine-voice-v1`, with a TypeScript reference beside it.
The owning engine mod supplies propeller geometry, speed range and acoustic
calibration. There are no aircraft identities or recordings in this generator.

Four independently phased rotor voices follow live RPM and load. Blade-passage
harmonics, shaft-order mechanical tone and broadband propeller noise use simulated
thrust, torque, inflow, air density and VRS. Pole counts and ESC switching tones
are intentionally absent because those electrical states are not simulated.
Gains and spectra are original approximations, not measured acoustic calibration.

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
