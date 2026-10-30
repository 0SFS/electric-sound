import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wasmRoot = path.join(root, "wasm");
const lock = JSON.parse(readFileSync(path.join(wasmRoot, "toolchain.lock.json")));
const sharedAbi = fileURLToPath(import.meta.resolve("@0sfs/engine-sound/voiceAbi"));
const fieldsMatch = readFileSync(sharedAbi, "utf8").match(/VOICE_INPUT_FIELDS = (\[[^;]+\]) as const/);
const fields = fieldsMatch ? JSON.parse(fieldsMatch[1]) : [];
if (fields.length !== 32 || fields[16] !== "rotorRpm" || fields[29] !== "resetCounter"
  || fields[30] !== "valid" || fields[31] !== "airframeOwner") throw new Error("Shared electric voice ABI changed; update Rust twin and tests together");
const run = (command, args, env = process.env) => execFileSync(command, args, { cwd: wasmRoot, env, encoding: "utf8" }).trim();
const rust = run("rustup", ["run", "stable", "rustc", "--version"]);
const cargo = run("rustup", ["run", "stable", "cargo", "--version"]);
if (!rust.startsWith(`rustc ${lock.rust} `) || !cargo.startsWith(`cargo ${lock.cargo} `)
  || process.versions.node !== lock.node) throw new Error("Installed Rust/cargo/Node differs from toolchain.lock.json");
const binaryen = process.env.WASM_OPT ?? (existsSync("/opt/homebrew/opt/emscripten/libexec/binaryen/bin/wasm-opt")
  ? "/opt/homebrew/opt/emscripten/libexec/binaryen/bin/wasm-opt" : "wasm-opt");
const optimizer = run(binaryen, ["--version"]);
if (!new RegExp(`\\b${lock.binaryen}\\b`).test(optimizer)) throw new Error("Binaryen differs from toolchain.lock.json");
const targetDirectory = path.join(root, "build/wasm/target");
const rustflags = `-C target-feature=+simd128 -C link-arg=-zstack-size=131072 -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=${lock.maximumMemoryBytes}`;
const args = ["+stable", "build", "-p", "electric-sound", "--release", "--locked", "--offline", "--target", lock.target];
run("cargo", args, { ...process.env, RUSTFLAGS: rustflags, CARGO_TARGET_DIR: targetDirectory });
const input = path.join(targetDirectory, lock.target, "release/electric_sound.wasm");
const output = "wasm/single/electric-sound.wasm";
const optimize = ["-O3", "--enable-simd", "--strip-debug"];
mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
run(binaryen, [input, ...optimize, "-o", path.join(root, output)]);
const bytes = readFileSync(path.join(root, output));
if (!WebAssembly.validate(bytes) || bytes.length > lock.maximumBinaryBytes) throw new Error("Invalid or oversized electric WASM");
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
if (imports.length) throw new Error("Electric voice cannot import host functions");
const exports = WebAssembly.Module.exports(module).map(entry => entry.name).sort();
const required = ["memory", "osfs_voice_abi_version", "osfs_voice_init", "osfs_voice_reset", "osfs_voice_input_ptr",
  "osfs_voice_output_ptr", "osfs_voice_profile_ptr", "osfs_voice_profile_size", "osfs_voice_commit_profile", "osfs_voice_process"];
if (required.some(name => !exports.includes(name))) throw new Error("Missing electric voice ABI exports");
const sha = data => createHash("sha256").update(data).digest("hex");
const digest = sha(bytes);
const publicWasm = "public/audio/electric-sound/voice.wasm";
mkdirSync(path.dirname(path.join(root, publicWasm)), { recursive: true });
writeFileSync(path.join(root, publicWasm), bytes);
const manifest = {
  schemaVersion: 1, id: "0sfs/electric-sound", kind: "component", name: "Electric sound",
  summary: "Shared electric motor and propeller sound generator.", execution: "wasm",
  provenance: { repository: "https://github.com/0SFS/electric-sound", owner: "0SFS", license: "AGPL-3.0-only", authors: ["0SFS contributors"] },
  audioRenderer: { apiVersion: 1, rendererId: "procedural-electric-v1", abi: "osfs-engine-voice-v1",
    engineClasses: ["electric"], telemetrySchemaIds: ["multirotor-electric-v1"],
    wasm: { path: "audio/electric-sound/voice.wasm", sha256: digest } },
};
writeFileSync(path.join(root, "public/0sfs-mod.json"), JSON.stringify(manifest, null, 2) + "\n");
const files = directory => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const name = path.posix.join(directory, entry.name);
  return entry.isDirectory() ? files(name) : [name];
});
const inputs = ["package.json", path.relative(root, sharedAbi), "wasm/Cargo.toml", "wasm/Cargo.lock", "wasm/rust-toolchain.toml", "wasm/toolchain.lock.json",
  ...files("wasm/crates"), ...files("wasm/scripts"), ...files("src")].sort();
const metadata = { schema: 1, core: "electric-sound", abi: "osfs-engine-voice-v1", rust, cargo, optimizer, node: process.versions.node,
  target: lock.target, maximumMemoryBytes: lock.maximumMemoryBytes,
  build: { command: ["cargo", ...args], rustflags, optimize: ["wasm-opt", ...optimize] },
  inputs: Object.fromEntries(inputs.map(file => [file, sha(readFileSync(path.join(root, file)))])),
  outputs: Object.fromEntries([output, publicWasm, "public/0sfs-mod.json"].map(file => {
    const content = readFileSync(path.join(root, file)); return [file, { sha256: sha(content), bytes: content.length }];
  })), imports, exports,
  performance: "unmeasured", power: "unmeasured" };
writeFileSync(path.join(wasmRoot, "build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify({ output, bytes: bytes.length, sha256: digest }));
