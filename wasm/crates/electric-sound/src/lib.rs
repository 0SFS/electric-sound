//! Four-voice electric motor/propeller synthesis. `src/reference.ts` is the
//! numeric twin. No heap allocation, host calls or memory growth while rendering.
//!
//! Static buffers belong to one unshared AudioWorklet instance. No reference
//! escapes a synchronous exported call; callers cannot re-enter the module.
#![allow(static_mut_refs)]

const VOICES: usize = 4;
const FRAMES: usize = 1024;
const STRIDE: usize = 32;
const PROFILE: usize = 10;
const TAU: f64 = 6.283185307179586;
const HALF_PI: f64 = 1.5707963267948966;
const UINT: f64 = 4294967296.0;

#[derive(Clone, Copy)]
struct Voice {
    profile: [f64; PROFILE],
    configured: bool,
    seed: u32,
    rng: u32,
    phase: f64,
    modulation: f64,
    smooth: [f64; 6],
    targets: [f64; 6],
    gate: f64,
    density: f64,
    low: f64,
    high: f64,
    wash: f64,
    counter: f64,
}
impl Voice {
    const EMPTY: Self = Self { profile: [0.0; PROFILE], configured: false, seed: 1,
        rng: 1, phase: 0.0, modulation: 0.0, smooth: [0.0; 6], targets: [0.0; 6], gate: 0.0, density: 1.225, low: 0.0, high: 0.0,
        wash: 0.0, counter: 0.0 };
    fn reset(&mut self) {
        self.rng = self.seed;
        self.phase = self.seed as f64 / UINT;
        self.modulation = self.seed as f64 / UINT;
        self.smooth.fill(0.0);
        self.targets.fill(0.0);
        self.gate = 0.0;
        self.density = 1.225;
        self.low = 0.0; self.high = 0.0; self.wash = 0.0; self.counter = 0.0;
    }
    fn random(&mut self) -> f64 {
        let mut x = self.rng;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        self.rng = x;
        self.rng as f64 / 2147483648.0 - 1.0
    }
}

static mut INPUT: [f64; VOICES * FRAMES * STRIDE] = [0.0; VOICES * FRAMES * STRIDE];
static mut OUTPUT: [f64; VOICES * 2 * FRAMES] = [0.0; VOICES * 2 * FRAMES];
static mut SETUP: [[f64; PROFILE]; VOICES] = [[0.0; PROFILE]; VOICES];
static mut STATE: [Voice; VOICES] = [Voice::EMPTY; VOICES];
static mut RATE: f64 = 48000.0;
static mut COUNT: usize = 0;
static mut MAX_BLOCK: usize = FRAMES;

#[inline]
fn finite(value: f64, fallback: f64) -> f64 { if value.is_finite() { value } else { fallback } }
#[inline]
fn clamp(value: f64, low: f64, high: f64) -> f64 { value.max(low).min(high) }

#[inline]
fn sine(phase: f64) -> f64 {
    let quadrant = (phase - phase.floor()) * 4.0;
    let folded = if quadrant <= 1.0 { quadrant } else if quadrant <= 3.0 { 2.0 - quadrant } else { quadrant - 4.0 };
    let x = folded * HALF_PI;
    let square = x * x;
    x * (1.0 + square * (-0.16666666666666666 + square * (0.008333333333333333
        + square * (-0.0001984126984126984 + square * (0.0000027557319223985893
        + square * -0.00000002505210838544172)))))
}

fn valid_profile(p: &[f64; PROFILE]) -> bool {
    p.iter().all(|value| value.is_finite() && *value >= 0.0)
        && p[0] >= 0.005 && p[0] <= 5.0
        && p[1].fract() == 0.0 && p[1] >= 1.0 && p[1] <= 16.0
        && p[2] > 0.0 && p[2] <= p[0] && p[3] <= 10.0 * p[0]
        && p[4] >= 100.0 && p[4] <= 100_000.0 && p[5] > 0.0 && p[5] <= 100_000.0
        && p[6..].iter().all(|value| *value <= 16.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_abi_version() -> u32 { 1 }
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_init(rate: f64, max_block: i32, seed: u32, voice_count: i32) -> u32 {
    if !rate.is_finite() || !(8000.0..=96000.0).contains(&rate) || !(1..=FRAMES as i32).contains(&max_block)
        || !(1..=VOICES as i32).contains(&voice_count) { return 0; }
    unsafe {
        RATE = rate; MAX_BLOCK = max_block as usize; COUNT = voice_count as usize;
        INPUT.fill(0.0); OUTPUT.fill(0.0); SETUP.fill([0.0; PROFILE]); STATE.fill(Voice::EMPTY);
        for (index, voice) in STATE[..COUNT].iter_mut().enumerate() {
            let own_seed = seed ^ (index as u32 + 1).wrapping_mul(0x9e3779b9);
            voice.seed = if own_seed == 0 { 1 } else { own_seed };
            voice.reset();
        }
    }
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_reset() {
    unsafe { for voice in &mut STATE[..COUNT] { voice.reset(); } OUTPUT.fill(0.0); }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_input_ptr() -> *mut f64 { unsafe { INPUT.as_mut_ptr() } }
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_output_ptr() -> *const f64 { unsafe { OUTPUT.as_ptr() } }
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_profile_ptr(voice: i32) -> *mut f64 {
    if !(0..VOICES as i32).contains(&voice) { return std::ptr::null_mut(); }
    unsafe { SETUP[voice as usize].as_mut_ptr() }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_profile_size() -> u32 { PROFILE as u32 }
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_commit_profile(voice: i32) -> u32 {
    unsafe {
        if voice < 0 || voice as usize >= COUNT { return 0; }
        let index = voice as usize;
        if !valid_profile(&SETUP[index]) { return 0; }
        STATE[index].profile = SETUP[index];
        STATE[index].configured = true;
        STATE[index].reset();
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_process(frames: i32) -> u32 {
    unsafe {
        if frames < 0 || frames as usize > MAX_BLOCK || COUNT == 0
            || STATE[..COUNT].iter().any(|voice| !voice.configured) { return 0; }
        let alpha = 1.0 / (1.0 + RATE * 0.01);
        for v in 0..COUNT {
            let voice = &mut STATE[v];
            let [radius, blades, chord, pitch, max_rpm, reference_thrust,
                tonal_gain, broadband_gain, mechanical_gain, output_gain] = voice.profile;
            for frame in 0..frames as usize {
                let offset = (v * FRAMES + frame) * STRIDE;
                let source_output = v * 2 * FRAMES + frame;
                OUTPUT[source_output] = 0.0;
                OUTPUT[source_output + FRAMES] = 0.0;
                let counter = finite(INPUT[offset + 29], 0.0);
                if counter != voice.counter { voice.reset(); voice.counter = counter; }
                if !(INPUT[offset + 24] > 0.0) { continue; }
                let valid = INPUT[offset + 30] > 0.5;
                voice.gate = clamp(voice.gate + if valid { 1.0 } else { -1.0 } / (RATE * 0.01), 0.0, 1.0);
                if valid {
                    voice.targets = [clamp(finite(INPUT[offset + 16], 0.0), 0.0, max_rpm * 2.0),
                        clamp(finite(INPUT[offset + 17], 0.0), 0.0, reference_thrust * 8.0),
                        finite(INPUT[offset + 18], 0.0).abs(), finite(INPUT[offset + 19], 0.0).abs(),
                        clamp(finite(INPUT[offset + 20], 0.0), 0.0, 1.0), finite(INPUT[offset + 22], 0.0).abs()];
                    voice.density = clamp(finite(INPUT[offset + 21], 1.225), 0.1, 3.0);
                }
                if voice.gate == 0.0 { continue; }
                let targets = voice.targets;
                for (smooth, target) in voice.smooth.iter_mut().zip(targets) { *smooth += alpha * (target - *smooth); }
                if targets[0] == 0.0 && voice.smooth[0] < 0.1 { voice.smooth[0] = 0.0; }
                let [rpm, thrust, torque, induced, vrs, axial] = voice.smooth;
                let rotation_hz = rpm / 60.0;
                voice.phase += rotation_hz / RATE;
                voice.phase -= voice.phase.floor();
                voice.modulation += rotation_hz * 0.09 / RATE;
                voice.modulation -= voice.modulation.floor();
                if rpm == 0.0 { continue; }
                let speed = rpm / max_rpm;
                let tip = TAU * radius * rotation_hz;
                let tip_scale = clamp(tip / 80.0, 0.0, 3.0);
                let load = clamp(thrust / reference_thrust, 0.0, 4.0);
                let torque_load = clamp(torque / (reference_thrust * radius * 0.08), 0.0, 4.0);
                let density = voice.density / 1.225;
                let cull = clamp(finite(INPUT[offset + 13], 1.0), 0.5, 2.0);
                let partials = clamp(finite(INPUT[offset + 25], 0.0), 0.0, 12.0).floor() as usize;
                let noise_bands = clamp(finite(INPUT[offset + 26], 0.0), 0.0, 8.0).floor() as usize;
                let harmonics = if partials == 1 { 1 } else { partials.saturating_sub(1) };
                let mut tone = 0.0;
                for harmonic in 1..=harmonics {
                    let order = harmonic as f64;
                    let frequency = rotation_hz * blades * order;
                    let anti_alias = clamp((RATE * 0.48 - frequency * cull) / (RATE * 0.08), 0.0, 1.0);
                    tone += sine(voice.phase * blades * order) * anti_alias
                        * (1.0 + pitch / (TAU * radius) * 0.15 * (order - 1.0)) / (order * order);
                }
                let tonal_envelope = speed * speed * (0.2 + 0.8 * load.sqrt()) * (0.5 + 0.5 * tip_scale);
                let mut result = tone * tonal_gain * tonal_envelope;
                if partials > 1 {
                    let anti_alias = clamp((RATE * 0.48 - rotation_hz * cull) / (RATE * 0.08), 0.0, 1.0);
                    result += sine(voice.phase) * mechanical_gain * speed * (0.2 + 0.8 * torque_load.sqrt()) * anti_alias;
                }
                if noise_bands > 0 {
                    let noise = voice.random();
                    let high_cut = clamp(700.0 + tip * 35.0 + (induced + axial) * 45.0, 20.0, RATE * 0.4);
                    let low_cut = clamp(150.0 + tip * 3.0, 20.0, high_cut * 0.6);
                    let high_omega = TAU * high_cut;
                    let low_omega = TAU * low_cut;
                    voice.high += high_omega / (RATE + high_omega) * (noise - voice.high);
                    voice.low += low_omega / (RATE + low_omega) * (noise - voice.low);
                    let geometry = clamp(chord * radius / 0.001, 0.05, 30.0).sqrt();
                    let broadband_envelope = tip_scale * tip_scale * (0.25 + 0.75 * load) * geometry * density;
                    let modulation = 1.0 + vrs * 0.2 * sine(voice.modulation);
                    result += (voice.high - voice.low) * broadband_gain * broadband_envelope * (1.0 + vrs * 0.8) * modulation;
                    if noise_bands > 1 {
                        let random = voice.random();
                        voice.wash += 0.02 * (random - voice.wash);
                        result += voice.wash * broadband_gain * speed * load * (0.2 + vrs * 0.6);
                    }
                }
                OUTPUT[source_output] = finite(result * output_gain * voice.gate, 0.0);
            }
        }
    }
    1
}
