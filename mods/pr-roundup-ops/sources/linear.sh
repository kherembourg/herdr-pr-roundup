#!/bin/sh
# Prints one JSON object: the started Linear issues (In Progress, In Review) of your teams,
# with assignee, project and the project's initiatives, for the panel's filters.
# The key: $LINEAR_API_KEY, else the macOS keychain item "herdr-linear".
# A file "linear-team" next to this script (a team key, such as ENG) keeps one team only.
svc=herdr-linear
key=${LINEAR_API_KEY:-$(security find-generic-password -a "$USER" -s "$svc" -w 2>/dev/null)}
[ -n "$key" ] || { echo "Linear key missing: set LINEAR_API_KEY, or run: security add-generic-password -a \"\$USER\" -s $svc -w" >&2; exit 2; }
team=$(cat "$(dirname "$0")/linear-team" 2>/dev/null | tr -d ' \n')
if [ -n "$team" ]; then tf=$(jq -n --arg t "$team" '{key: {eq: $t}}'); else tf='{"members": {"isMe": {"eq": true}}}'; fi
q='query($team: TeamFilter!) { viewer { name }
  issues(first: 250, filter: { team: $team, state: { type: { in: ["started"] } } }) {
    pageInfo { hasNextPage }
    nodes { identifier title url state { name } assignee { name } project { name initiatives { nodes { name } } } } } }'
out=$(curl -sS --max-time 20 https://api.linear.app/graphql -H "Authorization: $key" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg q "$q" --argjson team "$tf" '{query:$q, variables:{team:$team}}')") || { echo "linear request failed" >&2; exit 1; }
echo "$out" | jq -e '.data.issues' >/dev/null 2>&1 || { echo "linear: $(echo "$out" | jq -r '.errors[0].message // "bad response"' 2>/dev/null | head -1)" >&2; exit 1; }
echo "$out" | jq '{me: .data.viewer.name, more: .data.issues.pageInfo.hasNextPage, issues: [.data.issues.nodes[] | {identifier, title, url, state: .state.name,
  assignee: (.assignee.name // "Unassigned"), project: (.project.name // "No project"),
  initiatives: ([.project.initiatives.nodes[]?.name] | if length == 0 then ["No initiative"] else . end)}]}'
