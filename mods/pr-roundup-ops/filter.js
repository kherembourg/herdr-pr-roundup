// Which PRs need action, and why. Pure: no herdr imports, so a node script can test it.
// PRs come from github.js. Merging the lists adds reviewRequested.
export function reasons(pr) {
  const r = [];
  if (pr.reviewRequested) r.push("review");
  if (pr.isDraft) return r; // drafts are work in progress: only a review request shows them
  if (pr.ci?.state === "failed") r.push("CI");
  if (pr.reviewDecision === "CHANGES_REQUESTED") r.push("changes");
  if (pr.mergeable === "CONFLICTING") r.push("conflict");
  if (pr.threads?.length) r.push(`${pr.threads.length} thread${pr.threads.length > 1 ? "s" : ""}`);
  return r;
}

// One entry per PR from several searches; `review` is the list where a review is asked of me.
export function mergePrs(lists, review) {
  const keyOf = (p) => `${p.repo.toLowerCase()}#${p.number}`;
  const asked = new Set(review.map(keyOf));
  const seen = new Map();
  for (const p of [...lists.flat(), ...review]) {
    const key = keyOf(p);
    const prior = seen.get(key);
    if (p.ciKnown === false && prior?.ciKnown === true && prior.updatedAt === p.updatedAt) continue;
    seen.set(key, p);
  }
  return [...seen.values()].map((p) => ({ ...p, reviewRequested: asked.has(keyOf(p)) })).sort((a, b) => b.number - a.number);
}
