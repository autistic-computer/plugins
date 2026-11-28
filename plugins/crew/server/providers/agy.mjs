// Google Antigravity CLI (`agy`), which fronts Gemini models, driven through
// `agy --output-format stream-json -p=<prompt>`.
//
// agy has no OS-level read-only sandbox with shell access, and a headless run
// cannot answer a permission prompt: a denied tool ends the turn, usually with
// an empty answer. Measured on agy 1.5.17:
//   --mode plan                        reads a file by path and nothing else.
//                                      The `init` event lists grep_search,
//                                      find_by_name and list_dir, but the model
//                                      is not given them; `ls`, `grep`, `rg`,
//                                      `find` and `git diff` are each denied.
//                                      Reads outside the working directory or
//                                      of protected files ask, so are denied.
//   --dangerously-skip-permissions     everything runs, including writes, even
//                                      combined with --mode plan and --sandbox
// So `read-only` maps to plan mode (really read-only, and blind: it cannot
// search) and both write levels auto-approve. The mapping is reported by
// `providers`. A plan-mode worker left to explore reads files end to end: one
// review of a 3-line diff took 588k input tokens.

const ACCESS_ARGS = {
  "read-only": ["--mode", "plan"],
  "workspace-write": ["--dangerously-skip-permissions", "--sandbox"],
  full: ["--dangerously-skip-permissions"]
};

function summarizeTool(step) {
  const parameters = step.tool_info?.parameters;
  const detail = parameters ? JSON.stringify(parameters).replace(/\s+/g, " ").slice(0, 140) : "";
  const suffix = step.state === "ERROR" ? " (error)" : "";
  return `${step.tool_name ?? "tool"} ${detail}${suffix}`.trim();
}

export const agy = {
  name: "agy",
  title: "Google Antigravity CLI (Gemini)",
  install: "install Antigravity's `agy` CLI and sign in by running `agy` once",
  // The prompt is an argv element, so it must never pass through a shell.
  shell: false,
  versionArgs: ["--version"],
  speeds: [],
  access: {
    "read-only":
      "Plan mode: reads files by path and edits nothing. It has no grep, glob, or directory listing, and shell commands are denied; a denied command or a read outside `cwd` ends the run with status `denied`. Name every file it must read in the prompt. For a task that has to search the repo, use codex.",
    "workspace-write": "Auto-approves every tool with terminal sandboxing. Not a filesystem sandbox: it can write anywhere the shell can.",
    full: "Auto-approves every tool, no sandbox."
  },

  bin(env = process.env) {
    return env.CREW_AGY_BIN || "agy";
  },

  promptNote({ access }) {
    return access === "read-only"
      ? [
          "[environment]",
          "- This run can read files by path and nothing else: there is no grep, glob, or directory listing, and it cannot edit.",
          "- Do not call run_command. A denied command ends the run and discards your answer.",
          "- Read only files inside the working directory. Start from the files the request names and follow the paths they give you; do not guess at paths or read a file end to end when the request points at a range.",
          "- If you could not check something because you could not search for it, say so once, in one line.",
          "- Answer directly. Do not write a plan file or wait for approval."
        ].join("\n")
      : null;
  },

  /** What to do about a denial, given which tools were refused. */
  deniedHint(denied, { access }) {
    if (denied.some((name) => /read/i.test(name))) {
      return "agy asks before reading outside the working directory or a protected file (.env, .git, its own config), and nobody can answer. Keep every file the prompt names inside `cwd`, then spawn again.";
    }
    return access === "read-only"
      ? 'agy cannot run shell commands in read-only (plan mode). Spawn again; if the task needs the shell, use codex or access="workspace-write".'
      : "Spawn again, or narrow the task.";
  },

  build({ prompt, access, model, effort, resume }) {
    const args = ["--output-format", "stream-json", ...ACCESS_ARGS[access]];
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (resume) {
      args.push("--conversation", resume);
    }
    // `-p <prompt>` would swallow the next flag as its value; `-p=` attaches it.
    args.push(`-p=${prompt}`);
    return { args, stdin: null };
  },

  /**
   * `state` persists across lines of one run: response text arrives as deltas
   * keyed by step, and is only a message once the step is DONE.
   * @returns {Array<object>} normalized events for one stdout line
   */
  parse(line, state) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [{ type: "log", text: line }];
    }
    if (event.event === "init") {
      return event.conversation_id ? [{ type: "session", id: event.conversation_id }] : [];
    }
    if (event.event === "step_update") {
      const step = event.step_update ?? {};
      if (step.step_type === "agent_response") {
        state.text ??= new Map();
        const text = (state.text.get(step.step_index) ?? "") + (step.text_delta ?? "");
        if (step.state !== "DONE") {
          state.text.set(step.step_index, text);
          return [];
        }
        state.text.delete(step.step_index);
        return text.trim() ? [{ type: "message", text: text.trim() }] : [];
      }
      if (step.step_type === "tool" && (step.state === "ACTIVE" || step.state === "ERROR")) {
        return [{ type: "activity", text: summarizeTool(step) }];
      }
      return [];
    }
    if (event.event === "result") {
      const result = event.result ?? {};
      const events = [];
      if (result.usage) {
        events.push({ type: "usage", usage: result.usage });
      }
      events.push({
        type: "result",
        text: result.response ?? "",
        ok: result.status === "SUCCESS",
        status: result.status ?? null,
        denied: (result.denied_actions ?? []).map((action) => action.display_name ?? action.action ?? "tool")
      });
      return events;
    }
    return [];
  }
};
