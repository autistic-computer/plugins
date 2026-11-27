// OpenAI Codex CLI, driven through `codex exec --json`.
//
// The prompt travels over stdin (`-`) so quotes, backticks, and flags inside
// prose never cross a shell. stdout is one JSON event per line; the final
// answer is simply the last `agent_message` item before the process exits.

const SANDBOX = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  full: "danger-full-access"
};

function summarizeCommand(command) {
  // Codex wraps every command as `<shell> -lc '<command>'`; show the inside.
  const inner = /-lc\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return (inner ? inner[2] : command).replace(/\s+/g, " ").slice(0, 160);
}

export const codex = {
  name: "codex",
  title: "OpenAI Codex CLI",
  install: "npm install -g @openai/codex, then `codex login`",
  // Windows resolves the `codex.cmd` launcher through cmd.exe. Safe here
  // because only flags are on the command line; the prompt is on stdin.
  shell: process.platform === "win32",
  versionArgs: ["--version"],
  access: {
    "read-only": "OS sandbox: can read the repo and run inspection commands, cannot write.",
    "workspace-write": "OS sandbox: can write inside the working directory. No network unless network=true.",
    full: "No sandbox: full filesystem and network."
  },

  bin(env = process.env) {
    return env.CREW_CODEX_BIN || "codex";
  },

  promptNote() {
    return null;
  },

  build({ prompt, access, model, effort, network, webSearch, resume }) {
    const sandbox = SANDBOX[access];
    const shared = [];
    if (model) {
      shared.push("-m", model);
    }
    if (effort) {
      shared.push("-c", `model_reasoning_effort=${effort}`);
    }
    // Omitting `web_search` leaves Codex's own default active, so turning it
    // off has to be explicit.
    shared.push("-c", webSearch === false ? "web_search=disabled" : "web_search=live");
    // `workspace-write` cuts the network along with the filesystem, which
    // silently dooms any task that has to reach a cloud API or a database.
    if (network && sandbox === "workspace-write") {
      shared.push("-c", "sandbox_workspace_write.network_access=true");
    }

    if (resume) {
      // `codex exec resume` takes no `-s`. Left alone it falls back to the
      // sandbox in config.toml, not the one this call asked for, so pin it.
      return {
        args: ["exec", "resume", resume, ...shared, "-c", `sandbox_mode=${sandbox}`, "--skip-git-repo-check", "--json", "-"],
        stdin: prompt
      };
    }
    return {
      args: ["exec", ...shared, "-s", sandbox, "--skip-git-repo-check", "--json", "-"],
      stdin: prompt
    };
  },

  /** @returns {Array<object>} normalized events for one stdout line */
  parse(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [{ type: "log", text: line }];
    }
    switch (event.type) {
      case "thread.started":
        return [{ type: "session", id: event.thread_id }];
      case "turn.completed":
        return event.usage ? [{ type: "usage", usage: event.usage }] : [];
      case "turn.failed":
        return [{ type: "error", text: event.error?.message ?? "turn failed" }];
      case "error":
        return [{ type: "error", text: event.message ?? "error" }];
      case "item.started":
      case "item.completed": {
        const item = event.item ?? {};
        if (item.type === "agent_message") {
          return event.type === "item.completed" ? [{ type: "message", text: item.text ?? "" }] : [];
        }
        if (item.type === "command_execution") {
          const exit = item.exit_code == null ? "" : ` (exit ${item.exit_code})`;
          return [{ type: "activity", text: `$ ${summarizeCommand(item.command ?? "")}${exit}` }];
        }
        return item.type ? [{ type: "activity", text: item.type.replace(/_/g, " ") }] : [];
      }
      default:
        return [];
    }
  }
};
