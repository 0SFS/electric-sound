import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const receipt = JSON.parse(readFileSync(path.join(root, "wasm/build-metadata.json")));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [file, digest] of Object.entries(receipt.inputs)) {
  if (sha(readFileSync(path.join(root, file))) !== digest) throw new Error(`Electric WASM source drift: ${file}; run npm run build:wasm`);
}
for (const [file, expected] of Object.entries(receipt.outputs)) {
  const bytes = readFileSync(path.join(root, file));
  if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) throw new Error(`Electric WASM output drift: ${file}`);
}
const module = new WebAssembly.Module(readFileSync(path.join(root, "wasm/single/electric-sound.wasm")));
if (WebAssembly.Module.imports(module).length) throw new Error("Unexpected electric WASM host imports");
const instance = new WebAssembly.Instance(module, {});
if (instance.exports.osfs_voice_abi_version() !== 1) throw new Error("Electric voice ABI mismatch");
console.log("Electric voice source/binary receipt and ABI verified");
