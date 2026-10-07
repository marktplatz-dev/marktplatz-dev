import { describe, expect, test } from "bun:test";
import { emitters, pick, resolveSelection } from "../src/lib/emitters";
import type { Catalog, CatalogSkill } from "../src/lib/types";

const skill = (id: string): CatalogSkill => ({
  id,
  repo: `acme/${id}`,
  path: `skills/${id}`,
  version: "v1.0.0",
  sha: "a".repeat(40),
  contentHash: `sha256-${"b".repeat(64)}`,
  license: "MIT",
  promotedAt: "2026-09-25T00:00:00.000Z",
  description: `The ${id} skill.`,
  scan: { passed: true, scanners: [], findings: [] },
});

const catalog: Catalog = {
  skills: [skill("alpha"), skill("beta"), skill("gamma")],
  roles: [
    { id: "sre", name: "SRE", description: "d", skills: ["alpha", "beta"], held: [] },
    { id: "dev", name: "Dev", description: "d", skills: ["beta"], held: ["delta"] },
  ],
  held: [
    {
      ...skill("delta"),
      path: "skills/tools/delta",
      scan: {
        passed: false,
        scanners: [{ id: "skillspector", version: "1.0.0", blocked: true }],
        findings: [{ scanner: "skillspector", ruleId: "PE3", severity: "high", message: "access token" }],
      },
    },
  ],
};

const ctx = { repoUrl: "https://github.com/marktplatz-dev/marktplatz-dev.git", sha: "c".repeat(40) };

describe("resolveSelection", () => {
  const ids = (roles: string[], skills: string[]) => resolveSelection(catalog, roles, skills).map((s) => s.id);

  test("roles only", () => expect(ids(["sre"], [])).toEqual(["alpha", "beta"]));
  test("skills only", () => expect(ids([], ["gamma"])).toEqual(["gamma"]));
  test("mixed, without duplicates", () => expect(ids(["sre", "dev"], ["beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]));
  test("unknown ids are ignored", () => expect(ids(["nope"], ["nope"])).toEqual([]));
});

describe("pick", () => {
  test("chosen guilds install whole; single skills only when no chosen guild brings them", () => {
    const picked = pick(catalog, ["sre"], ["beta", "gamma"], false);
    expect(picked.guilds.map((g) => g.id)).toEqual(["sre"]);
    expect(picked.skills.map((s) => s.id)).toEqual(["gamma"]);
    expect(picked.held).toEqual([]);
  });

  test("held skills come only when asked for, from chosen guilds or chosen by name", () => {
    expect(pick(catalog, ["dev"], [], false).held).toEqual([]);
    expect(pick(catalog, ["dev"], [], true).held.map((h) => h.id)).toEqual(["delta"]);
    expect(pick(catalog, [], ["delta"], true).held.map((h) => h.id)).toEqual(["delta"]);
  });
});

describe("held skills", () => {
  const picked = pick(catalog, ["dev"], [], true);
  const upstream = { source: "git-subdir", url: "https://github.com/acme/delta.git", path: "skills/tools", sha: "a".repeat(40) };

  test("claude-code: installed from their own repository, marked as not cleared", () => {
    const out = emitters["claude-code"].emit(catalog, picked, ctx);
    const entry = JSON.parse(out.content).plugins[1];
    expect(entry).toMatchObject({ name: "delta", displayName: "delta (not cleared)", category: "not-cleared", source: upstream, strict: false, skills: ["./delta"] });
    expect(entry.description).toStartWith("NOT CLEARED by the marktplatz watch (skillspector/PE3).");
    expect(entry.keywords).toEqual(["not-cleared", "dev"]);
    expect(out.install).toContain("claude plugin install delta@marktplatz");
  });

  test("codex: the same, in its own format", () => {
    const out = emitters.codex.emit(catalog, picked, ctx);
    const entry = JSON.parse(out.content).plugins.at(-1);
    expect(entry).toMatchObject({ name: "delta", category: "Not cleared", source: upstream, skills: ["./delta"] });
    expect(entry.description).toStartWith("NOT CLEARED");
    expect(out.install.at(-1)).toBe("codex plugin add delta@marktplatz");
  });
});

describe("emitters", () => {
  test("claude-code: guilds become bundles, skills single plugins, with display fields and provenance", () => {
    const out = emitters["claude-code"].emit(catalog, pick(catalog, ["dev"], ["gamma"], false), ctx);
    const market = JSON.parse(out.content);
    expect(market).toMatchObject({ name: "marktplatz", owner: { name: "marktplatz.dev" } });
    expect(market.plugins).toHaveLength(2);
    expect(market.plugins[0]).toEqual({
      name: "dev-guild",
      displayName: "Dev (guild)",
      description: "d Brings 1 skill: beta.",
      author: { name: "marktplatz" },
      homepage: `https://github.com/marktplatz-dev/marktplatz-dev/blob/${ctx.sha}/roles/dev.yaml`,
      repository: "https://github.com/marktplatz-dev/marktplatz-dev",
      license: "MIT",
      keywords: ["beta"],
      category: "guilds",
      source: { source: "git-subdir", url: ctx.repoUrl, path: "approved", sha: ctx.sha },
      strict: false,
      skills: ["./beta/v1.0.0/skills/beta"],
    });
    expect(market.plugins[1]).toEqual({
      name: "gamma",
      description: "The gamma skill.",
      version: "v1.0.0",
      author: { name: "acme" },
      homepage: `https://github.com/acme/gamma/tree/${"a".repeat(40)}/skills/gamma`,
      repository: "https://github.com/acme/gamma",
      license: "MIT",
      keywords: [],
      category: "skills",
      source: { source: "git-subdir", url: ctx.repoUrl, path: "approved/gamma/v1.0.0", sha: ctx.sha },
      metadata: {
        upstream: { repo: "acme/gamma", path: "skills/gamma", sha: "a".repeat(40) },
        contentHash: `sha256-${"b".repeat(64)}`,
        admitted: "2026-09-25T00:00:00.000Z",
        scan: { passed: true, scanners: [] },
      },
    });
    expect(out.install).toEqual([
      "mkdir -p ~/.marktplatz/claude-code/.claude-plugin",
      "mv marketplace.json ~/.marktplatz/claude-code/.claude-plugin/",
      "claude plugin marketplace add ~/.marktplatz/claude-code",
      "claude plugin marketplace update marktplatz",
      "claude plugin install dev-guild@marktplatz",
      "claude plugin install gamma@marktplatz",
      "claude plugin update dev-guild@marktplatz",
      "claude plugin update gamma@marktplatz",
    ]);
  });

  test("codex: one plugin per skill, guilds unfolded", () => {
    const out = emitters.codex.emit(catalog, pick(catalog, ["sre"], ["gamma"], false), ctx);
    expect(JSON.parse(out.content).plugins.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(JSON.parse(out.content).plugins[0]).toEqual({
      name: "alpha",
      source: { source: "git-subdir", url: ctx.repoUrl, path: "approved/alpha/v1.0.0", sha: ctx.sha },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
    expect(out.install).toEqual([
      "mkdir -p ~/.marktplatz/codex/.agents/plugins",
      "mv marketplace.json ~/.marktplatz/codex/.agents/plugins/",
      "codex plugin marketplace add ~/.marktplatz/codex",
      "codex plugin add alpha@marktplatz",
      "codex plugin add beta@marktplatz",
      "codex plugin add gamma@marktplatz",
    ]);
  });
});
