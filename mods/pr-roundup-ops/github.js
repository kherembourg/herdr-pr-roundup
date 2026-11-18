import { exec } from "herdr";
import { NOT_SOURCE } from "./diff.js";

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const BOTS = {
  "copilot-pull-request-reviewer": "Copilot", Copilot: "Copilot", "greptile-apps": "Greptile",
  coderabbitai: "CodeRabbit", "chatgpt-codex-connector": "Codex", "gemini-code-assist": "Gemini",
};
const DETAIL_TTL = 120000;
const MIN_BACKOFF = 60000;
const REST_REVIEW_NOTE = "Open review threads are unavailable while GitHub GraphQL is rate-limited.";
const CHECKS = `
  statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { name status conclusion startedAt }
    ... on StatusContext { context state createdAt }
  } } }
`;
const CORE_FIELDS = `
  number title url isDraft headRefName baseRefName headRefOid updatedAt reviewDecision mergeable
  author { login }
  repository { nameWithOwner }
  headRepository { nameWithOwner }
  ${CHECKS}
`;

let graphqlUntil = 0;
let secondaryUntil = 0;
const restUntil = new Map();
let graphqlQueue = Promise.resolve();
let loginRequest;
const detailsCache = new Map();

class RateLimit extends Error {
  constructor(until, restAvailable) {
    const api = restAvailable ? "GitHub GraphQL" : "GitHub API";
    super(`${api} rate limit. Retry after ${new Date(until).toLocaleTimeString()}.`);
    this.restAvailable = restAvailable;
  }
}

async function request(endpoint, args = []) {
  const now = Date.now();
  if (now < secondaryUntil) throw new RateLimit(secondaryUntil, false);
  const isGraphql = endpoint === "graphql";
  const bucket = endpoint.startsWith("search/") ? "search" : "core";
  const blockedUntil = isGraphql ? graphqlUntil : restUntil.get(bucket) ?? 0;
  if (now < blockedUntil) throw new RateLimit(blockedUntil, isGraphql);
  const result = await exec("gh", ["api", endpoint, "--hostname", "github.com", "--include", ...args]);
  // gh prints the status line with LF and headers with CRLF.
  const split = result.stdout.match(/\r?\n\r?\n/);
  const head = split ? result.stdout.slice(0, split.index) : "";
  const body = (split ? result.stdout.slice(split.index + split[0].length) : result.stdout).trim();
  const headers = Object.fromEntries(head.split(/\r?\n/).slice(1).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const status = Number(head.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
  const responseAt = Date.now();
  const reset = Number(headers["x-ratelimit-reset"]) * 1000;
  const primary = headers["x-ratelimit-remaining"] === "0";
  const until = reset > responseAt ? reset : responseAt + MIN_BACKOFF;
  if (primary) {
    if (isGraphql) graphqlUntil = until;
    else restUntil.set(bucket, until);
  }

  let data;
  try { data = JSON.parse(body); } catch {}
  const error = data?.errors?.[0];
  const message = error?.message || data?.message || result.stderr.trim().split("\n")[0];
  const retryAfter = headers["retry-after"];
  const secondary = /secondary rate limit|abuse detection/i.test(message ?? "") || (!primary && (retryAfter || status === 429));
  if (secondary) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds) ? responseAt + seconds * 1000 : Date.parse(retryAfter ?? "");
    secondaryUntil = retryAt > responseAt ? retryAt : responseAt + MIN_BACKOFF;
    throw new RateLimit(secondaryUntil, false);
  }
  if (result.code !== 0 || error || status >= 400) {
    const limited = primary || error?.type === "RATE_LIMITED" || /rate limit (?:already )?exceeded/i.test(message ?? "");
    if (isGraphql && limited) {
      graphqlUntil = until;
      throw new RateLimit(graphqlUntil, true);
    }
    if (primary) throw new RateLimit(until, false);
    throw new Error(message || `GitHub request failed (${endpoint})`);
  }
  if (!data) throw new Error(`GitHub returned an invalid response (${endpoint})`);
  return data;
}

function graphql(query, fields = []) {
  const pending = graphqlQueue.then(() => request("graphql", ["-f", `query=${query}`, ...fields]));
  // Recheck quota before each request when an expansion races a summary refresh.
  graphqlQueue = pending.catch(() => null);
  return pending;
}

async function withRest(readGraphql, readRest) {
  try {
    return await readGraphql();
  } catch (error) {
    if (!(error instanceof RateLimit && error.restAvailable)) throw error;
    return readRest();
  }
}

function ci(contexts) {
  // Old failed or cancelled runs can remain in a rollup. Take the newest per check.
  const latest = new Map();
  for (const c of contexts) {
    const name = c.name ?? c.context;
    const at = c.startedAt ?? c.createdAt ?? "";
    if (!latest.has(name) || at >= latest.get(name).at) latest.set(name, { ...c, at });
  }
  const failed = [], running = [];
  let passed = 0;
  for (const [name, c] of latest) {
    if (c.context !== undefined) {
      if (FAILED.has(c.state)) failed.push(name);
      else if (c.state === "PENDING" || c.state === "EXPECTED") running.push(name);
      else if (c.state === "SUCCESS") passed++;
    } else if (c.status !== "COMPLETED") running.push(name);
    else if (FAILED.has(c.conclusion)) failed.push(name);
    else if (c.conclusion === "SUCCESS") passed++;
  }
  return { state: failed.length ? "failed" : running.length ? "running" : passed ? "ok" : "none", failed, running };
}

function identity(p) {
  const [owner, name] = p.repo.split("/");
  const group = name.toLowerCase().startsWith(owner.toLowerCase() + "-") || name.toLowerCase().startsWith(owner.toLowerCase() + "_")
    ? name.slice(owner.length + 1) : name;
  return {
    ...p,
    group,
    title: p.title.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\([A-Z]+-\d+\)\s*$/, "").replace(/^./, (c) => c.toUpperCase()),
    ticket: p.title.match(/\(([A-Z]+-\d+)\)\s*$/)?.[1] ?? null,
  };
}

function graphRow(pr) {
  return identity({
    number: pr.number, title: pr.title, url: pr.url, repo: pr.repository.nameWithOwner,
    author: pr.author, isDraft: pr.isDraft, updatedAt: pr.updatedAt, reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable, headRefName: pr.headRefName, baseRefName: pr.baseRefName, headSha: pr.headRefOid,
    headRepo: pr.headRepository?.nameWithOwner ?? null,
    ci: ci(pr.statusCheckRollup?.contexts.nodes.filter(Boolean) ?? []), ciKnown: true,
  });
}

function openThreads(pr) {
  return pr.reviewThreads.nodes.filter((t) => t && !t.isResolved && !t.isOutdated);
}

function filesChanged(files) {
  const source = files.filter((f) => !NOT_SOURCE.test(f.path));
  return { source, hidden: files.length - source.length };
}

const sorted = (rows) => rows.sort((a, b) => b.number - a.number);

function searchArgs(search) {
  return `${search} is:pr is:open archived:false`;
}

function restLogin() {
  loginRequest ??= request("user").then(({ login }) => {
    if (!login) throw new Error("Could not identify the GitHub account used by gh.");
    return login;
  }).catch((error) => {
    loginRequest = undefined;
    throw error;
  });
  return loginRequest;
}

async function restList(search) {
  if (search.includes(":@me")) search = search.replaceAll(":@me", ":" + await restLogin());
  const data = await request("search/issues", ["-X", "GET", "-f", `q=${searchArgs(search)}`, "-F", "per_page=100", "--jq",
    "{items:[.items[]|{number,title,html_url,repository_url,pull_request,draft,updated_at,user:{login:.user.login}}]}"]);
  return sorted(data.items.filter((p) => p.pull_request && p.repository_url).map((p) => identity({
    number: p.number, title: p.title, url: p.html_url, repo: p.repository_url.split("/").slice(-2).join("/"),
    author: p.user?.login ? p.user : null, isDraft: p.draft ?? null, updatedAt: p.updated_at,
    headRefName: null, baseRefName: null, headSha: null, headRepo: null, reviewDecision: null, mergeable: null,
    ci: ci([]), ciKnown: false, threads: [], threadsKnown: false, source: [], hidden: 0, detailsLoaded: false,
  })));
}

export async function fetchPrLists(scopes) {
  const entries = Object.entries(scopes);
  if (!entries.length) return {};
  return withRest(async () => {
    const signature = entries.map((_, i) => `$scope${i}:String!`).join(", ");
    const selections = entries.map((_, i) => `list${i}: search(query: $scope${i}, type: ISSUE, first: 100) {
      nodes { ... on PullRequest { ${CORE_FIELDS} reviewThreads(first: 100) { nodes { isResolved isOutdated } } } }
    }`).join("\n");
    const fields = entries.flatMap(([, search], i) => ["-f", `scope${i}=${searchArgs(search)}`]);
    const { data } = await graphql(`query(${signature}) { ${selections} }`, fields);
    return Object.fromEntries(entries.map(([key], i) => [key, sorted(data[`list${i}`].nodes.filter((p) => p?.number).map((p) => ({
      ...graphRow(p), threads: openThreads(p).map(() => ({})), threadsKnown: true, source: [], hidden: 0, detailsLoaded: false,
    })))]));
  }, async () => {
    // Avoid sending a burst of retries when GitHub begins throttling REST too.
    const results = [];
    for (const [key, search] of entries) results.push([key, await restList(search)]);
    return Object.fromEntries(results);
  });
}

const firstLine = (body) =>
  (body ?? "").replace(/<[^>]+>/g, " ").split("\n").map((line) => line.replace(/[#>*_`]/g, "").trim()).find((line) => line.length > 3) ?? "";

async function graphDetails(pr) {
  const [owner, name] = pr.repo.split("/");
  const { data } = await graphql(`query($owner:String!, $name:String!, $number:Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      ${CORE_FIELDS}
      reviewThreads(first: 100) { nodes {
        isResolved isOutdated comments(first: 1) { nodes { author { login } body path } }
      } }
      files(first: 100) { nodes { path additions deletions } }
    } }
  }`, ["-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`]);
  const pull = data.repository?.pullRequest;
  if (!pull) throw new Error(`GitHub did not return PR #${pr.number} in ${pr.repo}.`);
  const threads = openThreads(pull).map((thread) => {
    const comment = thread.comments.nodes.find(Boolean);
    const login = comment?.author?.login;
    const bot = Object.hasOwn(BOTS, login);
    return { who: bot ? BOTS[login] : login ?? "?", bot, path: comment?.path, text: firstLine(comment?.body) };
  });
  return {
    ...graphRow(pull), threads, threadsKnown: true, ...filesChanged(pull.files?.nodes.filter(Boolean) ?? []),
    detailsLoaded: true, filesKnown: Boolean(pull.files), detailsError: pull.files ? null : "GitHub did not return the changed files.",
  };
}

async function restContexts(repo, sha) {
  const prefix = `repos/${repo}/commits/${sha}`;
  const runs = await request(`${prefix}/check-runs`, ["-X", "GET", "-f", "filter=latest", "-F", "per_page=100"]);
  const status = await request(`${prefix}/status`, ["-X", "GET", "-F", "per_page=100"]);
  const contexts = [
    ...runs.check_runs.map((c) => ({ name: c.name, status: c.status.toUpperCase(), conclusion: c.conclusion?.toUpperCase(), startedAt: c.started_at })),
    ...status.statuses.map((c) => ({ context: c.context, state: c.state.toUpperCase(), createdAt: c.created_at })),
  ];
  return ci(contexts);
}

async function restDetails(pr) {
  const endpoint = `repos/${pr.repo}/pulls/${pr.number}`;
  const pull = await request(endpoint, ["--jq", "{head:{ref:.head.ref,sha:.head.sha,repo:{full_name:.head.repo.full_name}},base:{ref:.base.ref},mergeable}"]);
  const errors = [REST_REVIEW_NOTE];
  let files = [];
  let filesKnown = false;
  let checks = ci([]);
  let ciKnown = false;
  try {
    files = await request(`${endpoint}/files`, ["-X", "GET", "-F", "per_page=100", "--jq", "map({filename,additions,deletions})"]);
    filesKnown = true;
  } catch (error) {
    errors.push(`Changed files unavailable. ${error.message}`);
  }
  if (pull.head.sha) {
    try {
      checks = await restContexts(pr.repo, pull.head.sha);
      ciKnown = true;
    } catch (error) {
      errors.push(`CI checks unavailable. ${error.message}`);
    }
  }
  return {
    headRefName: pull.head.ref, baseRefName: pull.base.ref, headSha: pull.head.sha, headRepo: pull.head.repo?.full_name ?? null,
    mergeable: pull.mergeable === true ? "MERGEABLE" : pull.mergeable === false ? "CONFLICTING" : null,
    ci: checks, ciKnown, threads: [], threadsKnown: false,
    ...filesChanged(files.map(({ filename: path, additions, deletions }) => ({ path, additions, deletions }))),
    detailsLoaded: true, filesKnown, detailsError: errors.join(" "),
  };
}

export async function fetchPrDetails(pr) {
  const key = JSON.stringify([pr.repo.toLowerCase(), pr.number, pr.headSha, pr.updatedAt]);
  let cached = detailsCache.get(key);
  if (!cached || cached.until <= Date.now()) {
    cached = { until: Infinity };
    cached.pending = withRest(() => graphDetails(pr), () => restDetails(pr)).then((details) => {
      const ttl = details.threadsKnown ? DETAIL_TTL : Math.min(DETAIL_TTL, Math.max(0, graphqlUntil - Date.now()));
      cached.until = Date.now() + ttl;
      return details;
    }).catch((error) => {
      if (detailsCache.get(key) === cached) detailsCache.delete(key);
      throw error;
    });
    if (detailsCache.size >= 64 && !detailsCache.has(key)) detailsCache.delete(detailsCache.keys().next().value);
    detailsCache.set(key, cached);
  }
  return { ...pr, ...await cached.pending };
}
