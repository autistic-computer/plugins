// Gemini cites every file as a markdown link to an absolute `file://` URL. The
// orchestrator cannot follow one and pays for each: in a measured session of
// ten agy reviews the link targets were 29% of everything agy wrote (85k of
// 297k characters). Rewrite them to `path:line`, relative to the job's working
// directory, before the text reaches the board or a final answer.

import path from "node:path";

const MARKDOWN_LINK = /\[([^[\]\n]*)\]\((file:\/\/[^)\s]+)\)/g;
const BARE_URL = /file:\/\/[^\s)\]>"'`]+/g;
const LINE_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/;
const LABEL_LINES = /(?::L?\d+(?:-L?\d+)?|#L\d+(?:-L?\d+)?)$/;
const ONLY_LINES = /^L?\d+(?:-L?\d+)?$/;

function locate(url, cwd) {
  let file = url.replace(/^file:\/\/(?:localhost)?/, "");
  let lines = "";
  const hash = file.indexOf("#");
  if (hash !== -1) {
    const match = LINE_FRAGMENT.exec(file.slice(hash + 1));
    if (match) {
      lines = match[2] && match[2] !== match[1] ? `:${match[1]}-${match[2]}` : `:${match[1]}`;
    }
    file = file.slice(0, hash);
  }
  try {
    file = decodeURIComponent(file);
  } catch {
    // Not valid percent-encoding; show it as written.
  }
  // file:///C:/repo/a.js names C:/repo/a.js, not /C:/repo/a.js.
  if (/^\/[A-Za-z]:\//.test(file)) {
    file = file.slice(1);
  }
  if (cwd) {
    const relative = path.relative(cwd, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      file = relative;
    }
  }
  return { file: file.split(path.sep).join("/"), lines };
}

/** Replace `file://` links and URLs in worker text with plain `path:line` references. */
export function tidyLinks(text, cwd = null) {
  const value = String(text ?? "");
  if (!value.includes("file://")) {
    return value;
  }
  return value
    .replace(MARKDOWN_LINK, (_whole, label, url) => {
      const { file, lines } = locate(url, cwd);
      const quoted = label.startsWith("`") && label.endsWith("`") && label.length > 1;
      const bare = quoted ? label.slice(1, -1) : label;
      const labelLines = LABEL_LINES.exec(bare)?.[0] ?? "";
      const name = labelLines ? bare.slice(0, -labelLines.length) : bare;
      const reference = `${file}${lines || labelLines.replace(/^#/, ":").replace(/L/g, "")}`;
      // A label that is the file's own name, or only its line range, adds
      // nothing next to the path.
      if (ONLY_LINES.test(name) || file === name || file.endsWith(`/${name}`)) {
        return quoted ? `\`${reference}\`` : reference;
      }
      return name ? `${label} (${reference})` : reference;
    })
    .replace(BARE_URL, (url) => {
      const { file, lines } = locate(url, cwd);
      return `${file}${lines}`;
    });
}
