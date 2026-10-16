#!/bin/zsh
# derive-client SKILL.md (agent-browser 0.39.0) steps 2 and 3, verbatim jq, on one HAR.
# Usage: derive-steps.sh <har> <url-regex for step 3> <text to look for>
H=$1; U=$2; T=$3
echo "\$ jq -r '<derive-client §2 query>' $(basename $H)"
jq -r '.log.entries[]
  | select(.response.content.mimeType | test("json"))
  | "\(.request.method) \(.response.status) \(.request.url)"' $H
echo
echo "\$ jq '<derive-client §3 query, test(\"$U\")>' $(basename $H)"
jq --arg u "$U" '.log.entries[] | select(.request.url | test($u))
  | {request: {method: .request.method, headers: .request.headers,
     postData: .request.postData.text},
     response: .response.content.text}' $H
echo
echo "\$ jq -r '.log.entries[] | <method status mimeType url, frame/initiator fields>' $(basename $H)"
jq -r '.log.entries[] | "\(.request.method) \(.response.status) \(.response.content.mimeType) \(.request.url) pageref=\(.pageref // "-") initiator=\(._initiator.type // "-")"' $H
echo
echo "\$ grep -c '$T' $(basename $H)"
grep -c "$T" $H
echo
echo "\$ jq '.log.creator, .log.pages' $(basename $H)"
jq -c '.log.creator, .log.pages' $H
