// Which PRs need Kevin, and why. Pure: no herdr imports, so a node script can test it.
// A PR has the shape of pr-roundup-spaces/prs.js (ci.state, threads[]) plus reviewRequested.
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
  const asked = new Set(review.map((p) => `${p.repo}#${p.number}`));
  const seen = new Map();
  for (const p of [...lists.flat(), ...review]) seen.set(`${p.repo}#${p.number}`, p);
  return [...seen.values()].map((p) => ({ ...p, reviewRequested: asked.has(`${p.repo}#${p.number}`) })).sort((a, b) => b.number - a.number);
}
