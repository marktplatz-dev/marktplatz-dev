// Usage:
//   bun scripts/quarantine.ts updates      → moves every quarantine/<id>.yaml to its repository's newest release tag
//   bun scripts/quarantine.ts plan         → JSON list of skill ids that still need onboarding
//   bun scripts/quarantine.ts check <id>   → fetch, license, scan into .quarantine/<id>/ (exit 1 on failure)
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approvedDir, gateDir, loadQuarantine, ROOT } from "../src/lib/catalog";
import { stringify } from "yaml";
import { listTags, newerTag, stageSkill } from "../src/lib/fetch";
import { fetchRepoLicense, fetchRepoNotice } from "../src/lib/license";
import { scanSkill } from "../src/lib/scan";
import { contentHash, validateSkillDir } from "../src/lib/skill";

export const STAGING_DIR = join(ROOT, ".quarantine");

async function plan(): Promise<string[]> {
  const pending: string[] = [];
  for (const [id, m] of await loadQuarantine()) {
    // A version is checked once: it is either approved or held at the gate with its scan results.
    // stdout carries the JSON list, so the log goes to stderr.
    if (existsSync(approvedDir(id, m.version))) console.error(`approved ${id}@${m.version}`);
    else if (existsSync(gateDir(id, m.version))) console.error(`gate     ${id}@${m.version}`);
    else {
      console.error(`check    ${id}@${m.version}`);
      pending.push(id);
    }
  }
  return pending;
}

// A newer release upstream becomes a new version to check: the manifest moves to it, and the version already in
// the market keeps being served until the new one clears.
async function updates(): Promise<void> {
  const tags = new Map<string, Promise<string[]>>();
  for (const [id, manifest] of await loadQuarantine()) {
    if (!tags.has(manifest.repo)) tags.set(manifest.repo, listTags(manifest.repo));
    const next = newerTag(manifest.version, await tags.get(manifest.repo)!);
    if (!next) {
      console.log(`latest   ${id} ${manifest.version}`);
      continue;
    }
    await writeFile(join(ROOT, "quarantine", `${id}.yaml`), stringify({ repo: manifest.repo, path: manifest.path, version: next }));
    console.log(`update   ${id} ${manifest.version} → ${next}`);
  }
}

async function check(id: string): Promise<boolean> {
  const manifest = (await loadQuarantine()).get(id);
  if (!manifest) throw new Error(`quarantine/${id}.yaml not found`);

  const stage = join(STAGING_DIR, id);
  const skillDir = join(stage, "skill");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  console.log(`fetch    ${manifest.repo}@${manifest.version} ${manifest.path}`);
  const sha = await stageSkill(manifest, skillDir);
  await validateSkillDir(skillDir, id);
  const hash = await contentHash(skillDir);

  console.log(`license  ${manifest.repo}@${sha}`);
  const license = await fetchRepoLicense(manifest.repo, sha);
  await writeFile(join(stage, "LICENSE"), license.text);
  const notice = await fetchRepoNotice(manifest.repo, sha);
  if (notice !== null) await writeFile(join(stage, "NOTICE"), notice);
  console.log(`         ${license.spdx}`);

  await writeFile(
    join(stage, "provenance.json"),
    `${JSON.stringify({ id, ...manifest, sha, contentHash: hash, license: license.spdx }, null, 2)}\n`,
  );

  console.log("scan");
  const summary = await scanSkill(skillDir, join(stage, "scan"));
  for (const s of summary.scanners) console.log(`         ${s.id} ${s.version}: ${s.blocked ? "BLOCKED" : "ok"}`);
  for (const f of summary.findings) {
    console.log(`         [${f.severity}] ${f.scanner}/${f.ruleId} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.message}`);
  }
  console.log(summary.passed ? `PASSED   ${id}` : `BLOCKED  ${id}`);

  // Used as the job summary and as the promotion PR body.
  const upstream = `https://github.com/${manifest.repo}/tree/${sha}/${manifest.path}`;
  const report = [
    `## ${summary.passed ? "✅" : "❌"} ${id}@${manifest.version}`,
    "",
    `- Upstream: [${manifest.repo}@${sha.slice(0, 7)}](${upstream})`,
    `- License: ${license.spdx}`,
    `- Content hash: \`${hash}\``,
    "",
    "| Scanner | Version | Result |",
    "|---|---|---|",
    ...summary.scanners.map((s) => `| ${s.id} | ${s.version} | ${s.blocked ? "❌ blocked" : "✅ passed"} |`),
    "",
    ...(summary.findings.length
      ? ["| Severity | Scanner | Rule | Location | Message |", "|---|---|---|---|---|"]
      : ["No findings."]),
    ...summary.findings.map(
      (f) => `| ${f.severity} | ${f.scanner} | ${f.ruleId} | ${f.file ?? ""}${f.line ? `:${f.line}` : ""} | ${f.message.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    ),
    "",
  ].join("\n");
  await writeFile(join(stage, "report.md"), report);
  return summary.passed;
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === "updates") await updates();
  else if (command === "plan") console.log(JSON.stringify(await plan()));
  else if (command === "check" && arg) process.exit((await check(arg)) ? 0 : 1);
  else throw new Error("usage: quarantine.ts updates | plan | check <id>");
} catch (error) {
  console.error(`FAILED   ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
