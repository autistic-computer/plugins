// MCP Skills extension (io.modelcontextprotocol/skills). Serves every
// `skills/<name>/SKILL.md` next to this file, plus its supporting files, so the
// playbooks ship and update with the server rather than as a separate install.
//
// These live under `server/`, not the plugin's own `skills/` directory, on
// purpose: Claude Code would load that directory natively as well and every
// skill would show up twice.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ERR, RpcError } from "./rpc.mjs";

const CACHE = { ttlMs: 300_000, cacheScope: "public" };
const MIME = { ".md": "text/markdown", ".json": "application/json", ".txt": "text/plain" };

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    return null;
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) {
      fields[pair[1]] = pair[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return fields;
}

function walk(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walk(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export function loadSkills(root, { warn = () => {} } = {}) {
  const skills = [];
  const files = new Map();

  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, "SKILL.md");
    const frontmatter = existsSync(manifestPath) ? parseFrontmatter(readFileSync(manifestPath, "utf8")) : null;
    // The spec ties a skill's name to its directory, and both fields are required.
    if (!frontmatter?.description || frontmatter.name !== entry.name) {
      warn(`skipping skill ${entry.name}: SKILL.md needs frontmatter with a description and name: ${entry.name}`);
      continue;
    }
    const resources = walk(directory).map((relative) => {
      const filePath = path.join(directory, relative);
      const bytes = readFileSync(filePath);
      const uri = `skill://${entry.name}/${relative}`;
      const resource = { uri, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length };
      files.set(uri, { filePath, mimeType: MIME[path.extname(relative)] ?? "application/octet-stream", size: bytes.length });
      return resource;
    });
    skills.push({ uri: `skill://${entry.name}/SKILL.md`, frontmatter, resources });
  }

  return {
    list: () => ({ skills, ...CACHE }),

    get(uri) {
      const skill = skills.find((candidate) => candidate.uri === uri);
      if (!skill) {
        throw new RpcError(ERR.invalidParams, `Unknown skill: ${uri}`);
      }
      return { skill, ...CACHE };
    },

    read(uri) {
      const file = files.get(uri);
      if (!file) {
        throw new RpcError(ERR.invalidParams, `Unknown resource: ${uri}`);
      }
      const bytes = readFileSync(file.filePath);
      const content =
        file.mimeType === "application/octet-stream"
          ? { uri, mimeType: file.mimeType, blob: bytes.toString("base64") }
          : { uri, mimeType: file.mimeType, text: bytes.toString("utf8") };
      return { contents: [content], ...CACHE };
    },

    resources: () => ({
      resources: [...files].map(([uri, file]) => ({
        uri,
        name: uri.slice("skill://".length),
        mimeType: file.mimeType,
        size: file.size
      })),
      ...CACHE
    })
  };
}
