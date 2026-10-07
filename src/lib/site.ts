import { execFileSync } from "node:child_process";

export const REPO = "marktplatz-dev/marktplatz-dev";
export const REPO_URL = `https://github.com/${REPO}.git`;

/** The commit being built. Generated marketplace files pin every skill to it. */
export function buildSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
