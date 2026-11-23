# Builds the server as a static Linux binary (Docker, musl) and deploys it to BANWAGONG.
# Needs Docker Desktop running and an SSH alias for the server in ~/.ssh/config, e.g.
#   Host banwagong
#     HostName <server ip>
#     Port <ssh port>
#     User root
#     IdentityFile ~/.ssh/<key>
#
#   ./deploy/banwagong/update.ps1
param([string]$SshHost = "banwagong")
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $repo "target-linux"
New-Item -ItemType Directory -Force $out | Out-Null

# Static musl binary: runs on the server's Ubuntu 20.04 regardless of its glibc version.
docker run --rm `
  -v "$repo\apps\server:/src:ro" -v "${out}:/out" `
  -v hw-cargo-registry:/usr/local/cargo/registry -v hw-musl-target:/target `
  -e CARGO_TARGET_DIR=/target -w /src rust:1.97-alpine `
  sh -c "apk add --no-cache musl-dev cmake make perl g++ linux-headers >/dev/null && cargo build --release --locked && cp /target/release/ai-homework /out/"
if ($LASTEXITCODE) { throw "Build failed" }

scp "$out\ai-homework" "${SshHost}:/opt/ai-homework/ai-homework.new"
if ($LASTEXITCODE) { throw "Upload failed" }

# Migrations run on start; the previous binary is kept as ai-homework.prev for a quick rollback.
ssh $SshHost @'
set -e
cd /opt/ai-homework
chown www-data:www-data ai-homework.new && chmod 755 ai-homework.new
[ -f ai-homework ] && cp -p ai-homework ai-homework.prev
mv -f ai-homework.new ai-homework
systemctl restart ai-homework
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:8787/api/health && echo && exit 0; sleep 1; done
journalctl -u ai-homework -n 30 --no-pager; exit 1
'@
if ($LASTEXITCODE) { throw "Service did not come up; see the log above" }
Write-Host "Deployed: https://api.bryht.net/homework/api/health"
