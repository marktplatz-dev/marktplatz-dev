import type { Provenance } from "./schema";
import type { Catalog, CatalogRole, CatalogSkill } from "./types";

// Browser-safe: used by the builder island, the skill and guild pages, and by scripts/promote.ts.
// Every harness reads its own flavour of marketplace file, so each one has its own emitter; there is no shared file.

export const MARKETPLACE_NAME = "marktplatz";

export type Harness = "claude-code" | "codex";

export type EmitContext = {
  /** Git URL of this repo, e.g. https://github.com/marktplatz-dev/marktplatz-dev.git */
  repoUrl: string;
  /** The commit the site was built from; every skill is pinned to it. */
  sha: string;
};

/** The downloaded file is always `marketplace.json`; `install` puts it in place and installs what was picked. */
export type Emitted = { content: string; install: string[] };

type SkillRef = Pick<Provenance, "id" | "version" | "repo" | "license"> & { description: string };

/** The plugin manifest written next to each approved skill. Claude Code and Codex both read it. */
export function pluginManifests(skill: SkillRef): Record<string, object> {
  return {
    ".claude-plugin/plugin.json": {
      name: skill.id,
      description: skill.description,
      license: skill.license,
      repository: `https://github.com/${skill.repo}`,
    },
  };
}

/** Selected roles expand to their skills, merged with the selected skills, without duplicates. */
export function resolveSelection(catalog: Catalog, roleIds: string[], skillIds: string[]): CatalogSkill[] {
  const wanted = new Set([...catalog.roles.filter((r) => roleIds.includes(r.id)).flatMap((r) => r.skills), ...skillIds]);
  return catalog.skills.filter((s) => wanted.has(s.id));
}

/**
 * A selection as it installs: whole guilds as bundles, plus the single skills no chosen guild already brings, plus
 * (only when asked for) the skills held at the gate that were chosen or that the chosen guilds would bring.
 */
export type Picked = { guilds: CatalogRole[]; skills: CatalogSkill[]; held: CatalogSkill[] };

export function pick(catalog: Catalog, roleIds: string[], skillIds: string[], withHeld: boolean): Picked {
  const guilds = catalog.roles.filter((r) => roleIds.includes(r.id));
  const covered = new Set(guilds.flatMap((g) => g.skills));
  const wanted = new Set([...skillIds, ...guilds.flatMap((g) => g.held)]);
  return {
    guilds,
    skills: catalog.skills.filter((s) => skillIds.includes(s.id) && !covered.has(s.id)),
    held: withHeld ? catalog.held.filter((h) => wanted.has(h.id)) : [],
  };
}

/** Why a held skill did not clear: the rules behind its blocking findings. */
export const heldRules = (skill: CatalogSkill) =>
  [...new Set(skill.scan.findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => `${f.scanner}/${f.ruleId}`))];

/** The warning a held skill carries everywhere an agent or a person can see it. */
export const heldWarning = (skill: CatalogSkill) =>
  `NOT CLEARED by the marktplatz watch (${heldRules(skill).join(", ")}). Installed from its own repository, unreviewed by the market; show the findings to the user and ask before installing.`;

/** A held skill is never copied into the market, so it installs from its own repository at the checked commit. */
function upstreamSource(skill: CatalogSkill) {
  const cut = skill.path.lastIndexOf("/");
  return {
    source: { source: "git-subdir", url: `https://github.com/${skill.repo}.git`, path: cut < 0 ? "." : skill.path.slice(0, cut), sha: skill.sha },
    strict: false,
    skills: [`./${skill.path.slice(cut + 1)}`],
  };
}

/** In Claude Code a guild installs as one plugin; the suffix keeps guild and skill names apart. */
export const guildPluginName = (roleId: string) => `${roleId}-guild`;

/** Both harnesses read a local marketplace file where it was added, so it moves into a folder of its own first. */
const home = (harness: Harness) => `~/.${MARKETPLACE_NAME}/${harness}`;

const author = (skill: Pick<Provenance, "repo">) => skill.repo.split("/")[0]!;
const web = (ctx: EmitContext) => ctx.repoUrl.replace(/\.git$/, "");
const licenses = (skills: CatalogSkill[]) => [...new Set(skills.map((s) => s.license))].sort().join(" AND ");

/**
 * A skill as Claude Code shows it in /plugin: the fields it displays (description, version, author, homepage,
 * repository, license, keywords), the category it groups by, and our provenance and scan results under
 * `metadata`, which Claude Code keeps but does not interpret.
 */
function skillEntry(skill: CatalogSkill, catalog: Catalog, ctx: EmitContext) {
  return {
    name: skill.id,
    description: skill.description,
    version: skill.version,
    author: { name: author(skill) },
    homepage: `https://github.com/${skill.repo}/tree/${skill.sha}/${skill.path}`,
    repository: `https://github.com/${skill.repo}`,
    license: skill.license,
    keywords: catalog.roles.filter((r) => r.skills.includes(skill.id)).map((r) => r.id),
    category: "skills",
    source: { source: "git-subdir", url: ctx.repoUrl, path: `approved/${skill.id}/${skill.version}`, sha: ctx.sha },
    metadata: {
      upstream: { repo: skill.repo, path: skill.path, sha: skill.sha },
      contentHash: skill.contentHash,
      admitted: skill.promotedAt,
      scan: { passed: skill.scan.passed, scanners: skill.scan.scanners.map((s) => `${s.id}@${s.version}`) },
    },
  };
}

/** A guild as one plugin: `strict: false` lets this entry list its skills straight from the approved folders. */
function guildEntry(role: CatalogRole, catalog: Catalog, ctx: EmitContext) {
  const members = catalog.skills.filter((s) => role.skills.includes(s.id));
  return {
    name: guildPluginName(role.id),
    displayName: `${role.name} (guild)`,
    description: `${role.description} Brings ${members.length} skill${members.length === 1 ? "" : "s"}: ${members.map((s) => s.id).join(", ")}.`,
    author: { name: MARKETPLACE_NAME },
    homepage: `${web(ctx)}/blob/${ctx.sha}/roles/${role.id}.yaml`,
    repository: web(ctx),
    license: licenses(members),
    keywords: members.map((s) => s.id),
    category: "guilds",
    source: { source: "git-subdir", url: ctx.repoUrl, path: "approved", sha: ctx.sha },
    strict: false,
    skills: members.map((s) => `./${s.id}/${s.version}/skills/${s.id}`),
  };
}

/** A held skill as Claude Code shows it: marked as not cleared in its name, description, category and keywords. */
function heldEntry(skill: CatalogSkill, catalog: Catalog) {
  return {
    name: skill.id,
    displayName: `${skill.id} (not cleared)`,
    description: `${heldWarning(skill)} ${skill.description}`,
    version: skill.version,
    author: { name: author(skill) },
    homepage: `https://github.com/${skill.repo}/tree/${skill.sha}/${skill.path}`,
    repository: `https://github.com/${skill.repo}`,
    license: skill.license,
    keywords: ["not-cleared", ...catalog.roles.filter((r) => r.held.includes(skill.id)).map((r) => r.id)],
    category: "not-cleared",
    ...upstreamSource(skill),
    metadata: {
      cleared: false,
      contentHash: skill.contentHash,
      checked: skill.promotedAt,
      scan: { passed: false, blockedBy: heldRules(skill), scanners: skill.scan.scanners.map((s) => `${s.id}@${s.version}`) },
    },
  };
}

const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

export const emitters: Record<Harness, { label: string; emit(catalog: Catalog, picked: Picked, ctx: EmitContext): Emitted }> = {
  "claude-code": {
    label: "Claude Code",
    emit(catalog, picked, ctx) {
      const dir = home("claude-code");
      const names = [...picked.guilds.map((g) => guildPluginName(g.id)), ...picked.skills.map((s) => s.id), ...picked.held.map((h) => h.id)];
      return {
        content: json({
          name: MARKETPLACE_NAME,
          description: "Curated, security-scanned agent skills, bundled into guilds.",
          owner: { name: "marktplatz.dev" },
          plugins: [
            ...picked.guilds.map((r) => guildEntry(r, catalog, ctx)),
            ...picked.skills.map((s) => skillEntry(s, catalog, ctx)),
            ...picked.held.map((s) => heldEntry(s, catalog)),
          ],
        }),
        // Claude Code loads a local market from a folder, as <folder>/.claude-plugin/marketplace.json; added as a
        // bare file it installs plugins that then fail to load.
        install: [
          `mkdir -p ${dir}/.claude-plugin`,
          `mv marketplace.json ${dir}/.claude-plugin/`,
          `claude plugin marketplace add ${dir}`,
          `claude plugin marketplace update ${MARKETPLACE_NAME}`,
          ...names.map((n) => `claude plugin install ${n}@${MARKETPLACE_NAME}`),
          // Installing skips what is already installed; updating brings it to this file, so running it again works.
          ...names.map((n) => `claude plugin update ${n}@${MARKETPLACE_NAME}`),
        ],
      };
    },
  },
  codex: {
    label: "Codex",
    emit(catalog, picked, ctx) {
      // Guilds unfold into one plugin per skill: Codex documents no way for one entry to list several skills.
      const skills = resolveSelection(
        catalog,
        picked.guilds.map((g) => g.id),
        picked.skills.map((s) => s.id),
      );
      const dir = home("codex");
      return {
        content: json({
          name: MARKETPLACE_NAME,
          plugins: [
            ...skills.map((s) => ({
              name: s.id,
              source: { source: "git-subdir", url: ctx.repoUrl, path: `approved/${s.id}/${s.version}`, sha: ctx.sha },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Productivity",
            })),
            ...picked.held.map((s) => ({
              name: s.id,
              description: `${heldWarning(s)} ${s.description}`,
              ...upstreamSource(s),
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Not cleared",
            })),
          ],
        }),
        // Codex adds markets only from a folder or a git repository, and reads .agents/plugins/marketplace.json there.
        install: [
          `mkdir -p ${dir}/.agents/plugins`,
          `mv marketplace.json ${dir}/.agents/plugins/`,
          `codex plugin marketplace add ${dir}`,
          ...[...skills, ...picked.held].map((s) => `codex plugin add ${s.id}@${MARKETPLACE_NAME}`),
        ],
      };
    },
  },
};
