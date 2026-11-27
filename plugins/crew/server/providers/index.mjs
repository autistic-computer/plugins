// Provider registry. A provider is a plain object that knows how to turn a
// normalized job spec into an argv for one agent CLI and how to read that CLI's
// event stream back into normalized events:
//
//   { type: "session",  id }               the CLI's own session id, for resume
//   { type: "message",  text }             something the agent said (board entry)
//   { type: "activity", text }             a tool call or step, for status lines
//   { type: "usage",    usage }            token counts
//   { type: "result",   text, ok, denied } an explicit final result, if the CLI has one
//   { type: "error",    text }
//   { type: "log",      text }             non-JSON output
//
// A provider may also export `deniedHint(denied, { access })`: what to tell the
// orchestrator when a headless run was refused a permission.
//
// Adding a model means adding one file here; nothing else knows provider names.

import { spawn } from "node:child_process";

import { agy } from "./agy.mjs";
import { codex } from "./codex.mjs";

export const PROVIDERS = { codex, agy };

const probes = new Map();

/** Run `<bin> --version` once per binary and remember the answer. */
export function probe(provider, { env = process.env, timeoutMs = 8000 } = {}) {
  const bin = provider.bin(env);
  if (!probes.has(bin)) {
    probes.set(
      bin,
      new Promise((resolve) => {
        let output = "";
        let settled = false;
        const finish = (value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        };
        const child = spawn(bin, provider.versionArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: provider.shell,
          windowsHide: true,
          env
        });
        const timer = setTimeout(() => {
          child.kill();
          finish({ available: false, version: null, error: "version check timed out" });
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", (error) => {
          finish({ available: false, version: null, error: error.code === "ENOENT" ? `${bin} not found on PATH` : error.message });
        });
        child.on("exit", (code) => {
          finish(
            code === 0
              ? { available: true, version: output.trim().split("\n")[0] || null, error: null }
              : { available: false, version: null, error: `${bin} --version exited ${code}` }
          );
        });
      })
    );
  }
  return probes.get(bin);
}
