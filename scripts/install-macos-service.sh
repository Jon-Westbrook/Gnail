#!/bin/sh
set -eu

label="com.gnail.local"
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=$(command -v node)
launch_agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs/GNAIL"
plist="$launch_agents/$label.plist"

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

mkdir -p "$launch_agents" "$logs"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$repo_dir/server.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$repo_dir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$logs/server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$logs/server.error.log")</string>
</dict>
</plist>
EOF

plutil -lint "$plist" >/dev/null
if [ "${GNAIL_SERVICE_DRY_RUN:-}" = "1" ]; then
  printf 'Validated GNAIL service at %s\n' "$plist"
  exit 0
fi
launchctl bootout "gui/$UID" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$plist"
launchctl kickstart -k "gui/$UID/$label"

printf 'GNAIL service installed and started.\n'
printf 'Open http://127.0.0.1:3457\n'
printf 'Logs: %s\n' "$logs"
