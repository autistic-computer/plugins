import os from "node:os";
import process from "node:process";

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const LOAD_DECIMALS_SCALE = 100;

export const MACHINE_SCHEMA = {
  type: "object",
  description: "This machine now. Workers that build or test here share it; workers whose heavy work runs elsewhere barely touch it.",
  properties: {
    cpus: { type: "number", description: "Logical CPUs available to this process." },
    load_1m: { type: ["number", "null"], description: "One-minute load average. Above `cpus`, the machine is already oversubscribed. Null where the system does not report it." },
    memory_total_mb: { type: "number" },
    memory_free_mb: { type: "number", description: "Memory available without swapping." }
  },
  required: ["cpus", "load_1m", "memory_total_mb", "memory_free_mb"]
};

export function readMachine(system = os, platform = process.platform) {
  return {
    cpus: system.availableParallelism(),
    load_1m: platform === "win32" ? null : Math.round(system.loadavg()[0] * LOAD_DECIMALS_SCALE) / LOAD_DECIMALS_SCALE,
    memory_total_mb: Math.floor(system.totalmem() / BYTES_PER_MEBIBYTE),
    memory_free_mb: Math.floor(system.freemem() / BYTES_PER_MEBIBYTE)
  };
}
