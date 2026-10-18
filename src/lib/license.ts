export type GithubLicenseResponse = {
  license: { spdx_id: string | null } | null;
  content: string;
  encoding: string;
};

export type RepoLicense = { spdx: string; text: string };

/**
 * Licenses that are not in SPDX but that the market accepts, known by the sha256 of their exact text (lines
 * trimmed at the end). They are source-available, not open: `terms` says what they allow.
 */
export const KNOWN_LICENSES: Record<string, { id: string; terms: string }> = {
  "21837fba473da2d60e23af1a7a9a75ede0b6e404587f8b3bd442c3e6758f9ffe": {
    id: "LicenseRef-Databricks",
    terms: "Source-available: only for use with the Databricks Services, under your agreement with Databricks. Databricks may end it at any time.",
  },
};

export const licenseTerms = (id: string) => Object.values(KNOWN_LICENSES).find((l) => l.id === id)?.terms;

const fingerprint = (text: string) =>
  new Bun.CryptoHasher("sha256")
    .update(
      text
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .trim(),
    )
    .digest("hex");

/** Turns the GitHub license API response into a license, or throws if it isn't a recognized one. */
export function evaluateLicense(response: GithubLicenseResponse | null): RepoLicense {
  if (!response) throw new Error("repo has no license");
  if (response.encoding !== "base64") throw new Error(`unexpected license encoding: ${response.encoding}`);
  const text = Buffer.from(response.content, "base64").toString("utf8");
  const spdx = response.license?.spdx_id;
  if (spdx && spdx !== "NOASSERTION") return { spdx, text };
  const known = KNOWN_LICENSES[fingerprint(text)];
  if (!known) throw new Error("repo license is not a recognized SPDX license");
  return { spdx: known.id, text };
}

/** The repo's NOTICE file at an exact commit, if it has one: its attribution notices must travel with the files. */
export async function fetchRepoNotice(repo: string, sha: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/NOTICE`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NOTICE download returned ${res.status}`);
  return res.text();
}

/**
 * Reads the repo license at an exact commit via `GET /repos/{repo}/license?ref={sha}`, unauthenticated: an Actions
 * token comes from another organization, and some (databricks) answer it with 403. One call per check job.
 */
export async function fetchRepoLicense(repo: string, sha: string): Promise<RepoLicense> {
  const res = await fetch(`https://api.github.com/repos/${repo}/license?ref=${sha}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (res.status === 404) return evaluateLicense(null);
  if (!res.ok) throw new Error(`GitHub license API returned ${res.status}: ${await res.text()}`);
  return evaluateLicense((await res.json()) as GithubLicenseResponse);
}
