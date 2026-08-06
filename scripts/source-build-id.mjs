#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function git(root, args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", root, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || "git failed");
  return result.stdout;
}

export function computeSourceBuildId(root) {
  const base = git(root, ["describe", "--tags", "--always"]).trim();
  if (!git(root, ["status", "--porcelain"]).trim()) return base;

  const hash = createHash("sha256");
  hash.update(git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], null));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], null)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    hash.update("\0untracked\0");
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, path)));
  }
  return `${base}-dirty.${hash.digest("hex").slice(0, 16)}`;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  process.stdout.write(`${computeSourceBuildId(resolve(process.argv[2] ?? process.cwd()))}\n`);
}
