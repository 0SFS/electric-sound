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
const CONTROL_STRIDE: usize = 8;

/// Natural `~1/k^2` propeller harmonic weights with phase-dispersed sign on odd
/// upper harmonics (`-` on 3rd, 5th) so Low/Med/High share a warm, organic blade
/// tone without synth-like upper buzz or peak-slope stacking.
const HARMONIC_WEIGHTS: [f64; 6] = [0.0, 1.0, 0.30, -0.12, 0.06, -0.032];

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
    control_countdown: usize,
    last_partials: usize,
    active_harmonics: usize,
    anti1: f64,
    h_weight: [f64; 6],
    tonal_scale: f64,
    shaft_scale: f64,
    high_alpha: f64,
    low_alpha: f64,
    broadband_scale: f64,
    blade_mod_depth: f64,
    vrs_mod_depth: f64,
    wake_scale: f64,
}
impl Voice {
    const EMPTY: Self = Self {
        profile: [0.0; PROFILE],
        configured: false,
        seed: 1,
        rng: 1,
        phase: 0.0,
        modulation: 0.0,
        smooth: [0.0; 6],
        targets: [0.0; 6],
        gate: 0.0,
        density: 1.225,
        low: 0.0,
        high: 0.0,
        wash: 0.0,
        counter: 0.0,
        control_countdown: 0,
        last_partials: usize::MAX,
        active_harmonics: 0,
        anti1: 0.0,
        h_weight: [0.0; 6],
        tonal_scale: 0.0,
        shaft_scale: 0.0,
        high_alpha: 0.0,
        low_alpha: 0.0,
        broadband_scale: 0.0,
        blade_mod_depth: 0.0,
        vrs_mod_depth: 0.0,
        wake_scale: 0.0,
    };
    fn reset(&mut self) {
        self.rng = self.seed;
        self.phase = self.seed as f64 / UINT;
        self.modulation = self.seed as f64 / UINT;
        self.smooth.fill(0.0);
        self.targets.fill(0.0);
        self.gate = 0.0;
        self.density = 1.225;
        self.low = 0.0;
        self.high = 0.0;
        self.wash = 0.0;
        self.counter = 0.0;
        self.control_countdown = 0;
        self.last_partials = usize::MAX;
        self.active_harmonics = 0;
        self.anti1 = 0.0;
        self.h_weight.fill(0.0);
        self.tonal_scale = 0.0;
        self.shaft_scale = 0.0;
        self.high_alpha = 0.0;
        self.low_alpha = 0.0;
        self.broadband_scale = 0.0;
        self.blade_mod_depth = 0.0;
        self.vrs_mod_depth = 0.0;
        self.wake_scale = 0.0;
    }
    fn random(&mut self) -> f64 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
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
fn finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}
#[inline]
fn clamp(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

#[inline]
fn sine(phase: f64) -> f64 {
    let quadrant = (phase - phase.floor()) * 4.0;
    let folded = if quadrant <= 1.0 {
        quadrant
    } else if quadrant <= 3.0 {
        2.0 - quadrant
    } else {
        quadrant - 4.0
    };
    let x = folded * HALF_PI;
    let square = x * x;
    x * (1.0
        + square
            * (-0.16666666666666666
                + square
                    * (0.008333333333333333
                        + square
                            * (-0.0001984126984126984
                                + square
                                    * (0.0000027557319223985893
                                        + square * -0.00000002505210838544172)))))
}

fn valid_profile(p: &[f64; PROFILE]) -> bool {
    p.iter().all(|value| value.is_finite() && *value >= 0.0)
        && p[0] >= 0.005
        && p[0] <= 5.0
        && p[1].fract() == 0.0
        && p[1] >= 1.0
        && p[1] <= 16.0
        && p[2] > 0.0
        && p[2] <= p[0]
        && p[3] <= 10.0 * p[0]
        && p[4] >= 100.0
        && p[4] <= 100_000.0
        && p[5] > 0.0
        && p[5] <= 100_000.0
        && p[6..].iter().all(|value| *value <= 16.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_init(rate: f64, max_block: i32, seed: u32, voice_count: i32) -> u32 {
    if !rate.is_finite()
        || !(8000.0..=96000.0).contains(&rate)
        || !(1..=FRAMES as i32).contains(&max_block)
        || !(1..=VOICES as i32).contains(&voice_count)
    {
        return 0;
    }
    unsafe {
        RATE = rate;
        MAX_BLOCK = max_block as usize;
        COUNT = voice_count as usize;
        INPUT.fill(0.0);
        OUTPUT.fill(0.0);
        SETUP.fill([0.0; PROFILE]);
        STATE.fill(Voice::EMPTY);
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
    unsafe {
        for voice in &mut STATE[..COUNT] {
            voice.reset();
        }
        OUTPUT.fill(0.0);
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_input_ptr() -> *mut f64 {
    unsafe { INPUT.as_mut_ptr() }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_output_ptr() -> *const f64 {
    unsafe { OUTPUT.as_ptr() }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_profile_ptr(voice: i32) -> *mut f64 {
    if !(0..VOICES as i32).contains(&voice) {
        return std::ptr::null_mut();
    }
    unsafe { SETUP[voice as usize].as_mut_ptr() }
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_profile_size() -> u32 {
    PROFILE as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_commit_profile(voice: i32) -> u32 {
    unsafe {
        if voice < 0 || voice as usize >= COUNT {
            return 0;
        }
        let index = voice as usize;
        if !valid_profile(&SETUP[index]) {
            return 0;
        }
        STATE[index].profile = SETUP[index];
        STATE[index].configured = true;
        STATE[index].reset();
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn osfs_voice_process(frames: i32) -> u32 {
    unsafe {
        if frames < 0
            || frames as usize > MAX_BLOCK
            || COUNT == 0
            || STATE[..COUNT].iter().any(|voice| !voice.configured)
        {
            return 0;
        }
        let alpha = 1.0 / (1.0 + RATE * 0.01);
        let gate_step = 1.0 / (RATE * 0.01);
        let inv_rate = 1.0 / RATE;
        let nyquist_limit = RATE * 0.48;
        let inv_fade_bw = 1.0 / (RATE * 0.08);
        for v in 0..COUNT {
            let voice = &mut STATE[v];
            let [
                radius,
                blades,
                chord,
                pitch,
                max_rpm,
                reference_thrust,
                tonal_gain,
                broadband_gain,
                mechanical_gain,
                output_gain,
            ] = voice.profile;
            let inv_max_rpm = 1.0 / max_rpm;
            let inv_ref_thrust = 1.0 / reference_thrust;
            let inv_ref_torque = 1.0 / (reference_thrust * radius * 0.08);
            let pitch_slope = pitch / (TAU * radius) * 0.15;
            let geometry = clamp(chord * radius / 0.001, 0.05, 30.0).sqrt();
            for frame in 0..frames as usize {
                let offset = (v * FRAMES + frame) * STRIDE;
                let source_output = v * 2 * FRAMES + frame;
                OUTPUT[source_output] = 0.0;
                OUTPUT[source_output + FRAMES] = 0.0;
                let counter = finite(INPUT[offset + 29], 0.0);
                if counter != voice.counter {
                    voice.reset();
                    voice.counter = counter;
                }
                if !(INPUT[offset + 24] > 0.0) {
                    continue;
                }
                let valid = INPUT[offset + 30] > 0.5;
                voice.gate = clamp(
                    voice.gate + if valid { gate_step } else { -gate_step },
                    0.0,
                    1.0,
                );
                if valid {
                    voice.targets = [
                        clamp(finite(INPUT[offset + 16], 0.0), 0.0, max_rpm * 2.0),
                        clamp(finite(INPUT[offset + 17], 0.0), 0.0, reference_thrust * 8.0),
                        finite(INPUT[offset + 18], 0.0).abs(),
                        finite(INPUT[offset + 19], 0.0).abs(),
                        clamp(finite(INPUT[offset + 20], 0.0), 0.0, 1.0),
                        finite(INPUT[offset + 22], 0.0).abs(),
                    ];
                    voice.density = clamp(finite(INPUT[offset + 21], 1.225), 0.1, 3.0);
                }
                if voice.gate == 0.0 {
                    continue;
                }
                let targets = voice.targets;
                for (smooth, target) in voice.smooth.iter_mut().zip(targets) {
                    *smooth += alpha * (target - *smooth);
                }
                if targets[0] == 0.0 && voice.smooth[0] < 0.1 {
                    voice.smooth[0] = 0.0;
                }
                let [rpm, thrust, torque, induced, vrs, axial] = voice.smooth;
                let rotation_hz = rpm / 60.0;
                voice.phase += rotation_hz * inv_rate;
                voice.phase -= voice.phase.floor();
                voice.modulation += rotation_hz * 0.09 * inv_rate;
                voice.modulation -= voice.modulation.floor();
                if rpm == 0.0 {
                    voice.control_countdown = 0;
                    continue;
                }
                let partials = clamp(finite(INPUT[offset + 25], 0.0), 0.0, 12.0).floor() as usize;
                let noise_bands = clamp(finite(INPUT[offset + 26], 0.0), 0.0, 8.0).floor() as usize;
                let blade_phase = voice.phase * blades;
                let blade_sin = sine(blade_phase);

                if voice.control_countdown == 0 || partials != voice.last_partials {
                    voice.control_countdown = CONTROL_STRIDE;
                    voice.last_partials = partials;
                    let speed = rpm * inv_max_rpm;
                    let tip = TAU * radius * rotation_hz;
                    let tip_scale = clamp(tip / 80.0, 0.0, 3.0);
                    let load = clamp(thrust * inv_ref_thrust, 0.0, 4.0);
                    let load_sqrt = load.sqrt();
                    let torque_load = clamp(torque * inv_ref_torque, 0.0, 4.0);
                    let density = voice.density / 1.225;
                    let cull = clamp(finite(INPUT[offset + 13], 1.0), 0.5, 2.0);
                    let cosine = clamp(finite(INPUT[offset + 14], 0.0), -1.0, 1.0);
                    let dir_weight = clamp(finite(INPUT[offset + 15], 0.0), 0.0, 1.0);
                    let in_plane = 1.0 - cosine.abs();
                    let high_fidelity = INPUT[offset + 28] > 0.5;
                    let harmonics = if partials == 0 {
                        0
                    } else if partials == 1 {
                        3
                    } else if high_fidelity {
                        5
                    } else {
                        4
                    };
                    let bpf_hz = rotation_hz * blades;
                    if harmonics > 0 && bpf_hz * cull < nyquist_limit {
                        voice.anti1 =
                            clamp((nyquist_limit - bpf_hz * cull) * inv_fade_bw, 0.0, 1.0);
                        let directivity_bright = 1.0 + dir_weight * (0.25 * in_plane - 0.08);
                        let mut max_h = 1;
                        for harmonic in 2..=harmonics {
                            let order = harmonic as f64;
                            let frequency = bpf_hz * order;
                            if frequency * cull >= nyquist_limit {
                                break;
                            }
                            max_h = harmonic;
                            let anti_alias =
                                clamp((nyquist_limit - frequency * cull) * inv_fade_bw, 0.0, 1.0);
                            voice.h_weight[harmonic] = (1.0 + pitch_slope * (order - 1.0))
                                * directivity_bright
                                * HARMONIC_WEIGHTS[harmonic]
                                * anti_alias;
                        }
                        voice.active_harmonics = max_h;
                    } else {
                        voice.active_harmonics = 0;
                        voice.anti1 = 0.0;
                    }
                    let tonal_envelope =
                        speed * speed * (0.2 + 0.8 * load_sqrt) * (0.5 + 0.5 * tip_scale);
                    voice.tonal_scale = tonal_gain * tonal_envelope;
                    if partials > 1 {
                        let shaft_anti =
                            clamp((nyquist_limit - rotation_hz * cull) * inv_fade_bw, 0.0, 1.0);
                        voice.shaft_scale =
                            mechanical_gain * speed * (0.2 + 0.8 * torque_load.sqrt()) * shaft_anti;
                    } else {
                        voice.shaft_scale = 0.0;
                    }
                    let high_cut = clamp(
                        650.0 + tip * 32.0 + (induced + axial) * 42.0,
                        20.0,
                        RATE * 0.38,
                    );
                    let low_cut = clamp(150.0 + tip * 3.0, 20.0, high_cut * 0.6);
                    let high_omega = TAU * high_cut;
                    let low_omega = TAU * low_cut;
                    voice.high_alpha = high_omega / (RATE + high_omega);
                    voice.low_alpha = low_omega / (RATE + low_omega);
                    let broadband_envelope =
                        tip_scale * tip_scale * (0.25 + 0.75 * load) * geometry * density;
                    let low_tier_trim = if partials == 1 { 0.82 } else { 1.0 };
                    voice.broadband_scale =
                        broadband_gain * broadband_envelope * (1.0 + vrs * 0.8) * low_tier_trim;
                    voice.blade_mod_depth = 0.22 + 0.10 * load_sqrt;
                    voice.vrs_mod_depth = vrs * 0.2;
                    voice.wake_scale = broadband_gain * speed * load * (0.2 + vrs * 0.6);
                }
                voice.control_countdown -= 1;

                let mut tone = 0.0;
                if voice.active_harmonics > 0 {
                    tone = blade_sin * voice.anti1;
                    if voice.active_harmonics > 1 {
                        let c1 = sine(blade_phase + 0.25);
                        let two_c1 = 2.0 * c1;
                        let mut s_prev = 0.0;
                        let mut s_curr = blade_sin;
                        for harmonic in 2..=voice.active_harmonics {
                            let s_next = two_c1 * s_curr - s_prev;
                            s_prev = s_curr;
                            s_curr = s_next;
                            tone += s_next * voice.h_weight[harmonic];
                        }
                    }
                }
                let mut result = tone * voice.tonal_scale;
                if partials > 1 {
                    result += sine(voice.phase) * voice.shaft_scale;
                }
                if noise_bands > 0 {
                    let noise = voice.random();
                    voice.high += voice.high_alpha * (noise - voice.high);
                    voice.low += voice.low_alpha * (noise - voice.low);
                    let modulation = 1.0
                        + voice.blade_mod_depth * blade_sin
                        + voice.vrs_mod_depth * sine(voice.modulation);
                    result += (voice.high - voice.low) * voice.broadband_scale * modulation;
                    if noise_bands > 1 {
                        let random = voice.random();
                        voice.wash += 0.02 * (random - voice.wash);
                        result += voice.wash * voice.wake_scale;
                    }
                }
                OUTPUT[source_output] = finite(result * output_gain * voice.gate, 0.0);
            }
        }
    }
    1
}
