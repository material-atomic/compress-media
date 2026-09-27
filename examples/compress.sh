#!/usr/bin/env bash
# Compress one file through a running Compress Media server, using the chunked upload API.
# Works whether the server stores uploads on disk (STORAGE=local) or in object storage (STORAGE=s3).
#
#   ./compress.sh <file> [options-json] [server-url]
#   ./compress.sh "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}'
#   ./compress.sh photo.heic '{"image":{"format":"webp","maxDim":1920}}' https://media.example.com
#
# Needs curl and jq. Writes <name>-compressed.<ext> next to the input.
set -euo pipefail

FILE=${1:?usage: compress.sh <file> [options-json] [server-url]}
OPTIONS=${2:-'{}'}
BASE=${3:-${COMPRESS_MEDIA_URL:-http://localhost:4747}}
NAME=$(basename "$FILE")
SIZE=$(wc -c < "$FILE" | tr -d ' ')
PART_FILE=$(mktemp)
trap 'rm -f "$PART_FILE"' EXIT

# 1. Start the upload: the server says how to split the file and where parts go.
UPLOAD=$(curl -sf -X POST "$BASE/api/uploads" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg name "$NAME" --argjson size "$SIZE" '{name: $name, size: $size}')")
ID=$(jq -r .uploadId <<<"$UPLOAD")
PART_SIZE=$(jq -r .partSize <<<"$UPLOAD")
PARTS=$(jq -r .partCount <<<"$UPLOAD")
DIRECT=$(jq -r .direct <<<"$UPLOAD")

# 2. Upload each part (retrying a few times). Parts are independent, so they could also run in parallel.
for n in $(seq 1 "$PARTS"); do
  dd if="$FILE" of="$PART_FILE" bs="$PART_SIZE" skip=$((n - 1)) count=1 2>/dev/null
  for attempt in 1 2 3 4 5; do
    if [ "$DIRECT" = true ]; then
      # Object storage: PUT straight to a presigned URL (no extra headers).
      URL=$(curl -sf -X POST "$BASE/api/uploads/$ID/parts/$n/url" | jq -r .url)
      curl -sf -X PUT -H 'Content-Type:' --data-binary "@$PART_FILE" "$URL" -o /dev/null && break
    else
      curl -sf -X PUT -H 'Content-Type: application/octet-stream' --data-binary "@$PART_FILE" \
        "$BASE/api/uploads/$ID/parts/$n" -o /dev/null && break
    fi
    [ "$attempt" = 5 ] && { echo "part $n failed" >&2; exit 1; }
    sleep "$attempt"
  done
  printf '\ruploaded %d/%d parts' "$n" "$PARTS" >&2
done
echo >&2

# 3. Complete the upload with the compression options; this creates the job.
JOB=$(curl -sf -X POST "$BASE/api/uploads/$ID/complete" -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson options "$OPTIONS" '{options: $options}')" | jq -r .id)

# 4. Wait for the job.
while :; do
  STATE=$(curl -sf "$BASE/api/jobs/$JOB")
  STATUS=$(jq -r .status <<<"$STATE")
  case $STATUS in
    done) break ;;
    error | cancelled) echo "job $STATUS: $(jq -r .error <<<"$STATE")" >&2; exit 1 ;;
    *) printf '\r%s %3.0f%%' "$STATUS" "$(jq -r '(.progress // 0) * 100' <<<"$STATE")" >&2; sleep 1 ;;
  esac
done
echo >&2

# 5. Download the result (-L: with object storage this redirects to a presigned URL), then clean up.
OUT="$(dirname "$FILE")/$(jq -r .outputName <<<"$STATE")"
curl -sfL -o "$OUT" "$BASE/api/jobs/$JOB/file"
curl -sf -X DELETE "$BASE/api/jobs/$JOB" -o /dev/null
echo "$(jq -r '"\(.inputSize) → \(.outputSize) bytes"' <<<"$STATE")  $OUT"
