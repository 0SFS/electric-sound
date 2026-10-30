/** Resolve through the owning package so non-root deployments keep working. */
export const electricSoundWasmUrl = new URL("../wasm/single/electric-sound.wasm", import.meta.url);
export const electricWasmUrl = electricSoundWasmUrl;
