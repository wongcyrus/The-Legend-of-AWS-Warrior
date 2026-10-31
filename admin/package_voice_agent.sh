#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash admin/package_voice_agent.sh EXISTING_PRIVATE_ARTIFACT_BUCKET" >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
bucket="$1"
if [[ ! "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "Invalid S3 bucket name" >&2
  exit 2
fi
cd "$root"
npm ci --prefix src/VoiceAgent --omit=dev --cpu=arm64 --os=linux --ignore-scripts --no-audit --no-fund
mkdir -p .aws-sam
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path("src/VoiceAgent")
with ZipFile(".aws-sam/voice-agent.zip", "w", ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.name.endswith(".test.mjs"):
            archive.write(path, path.relative_to(root))
PY
hash="$(sha256sum .aws-sam/voice-agent.zip | cut -d ' ' -f 1)"
key="voice-agent/${hash}.zip"
aws s3 cp .aws-sam/voice-agent.zip "s3://${bucket}/${key}" --sse AES256 --only-show-errors
printf 'VoiceAgentCodeBucket=%s\nVoiceAgentCodeKey=%s\n' "$bucket" "$key"
