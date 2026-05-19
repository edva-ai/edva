# Installer — 24/7 deployment

The quickstart runs Merlin in the foreground of a terminal. For an always-on agent that survives reboots, install it as a system service.

## macOS — launchd

A LaunchAgent plist lives in `~/Library/LaunchAgents/` and is owned by your user. Process-manager runs in your GUI session (required because some agent tools depend on UI permissions — Apple Notes, iMessage, AppleScript, Chrome automation).

### 1. Create the plist

Save the following as `~/Library/LaunchAgents/ai.merlin.session.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.merlin.session</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>YOUR_MERLIN_HOME/agent/bin/process-manager.mjs</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>MERLIN_HOME</key>
        <string>YOUR_MERLIN_HOME</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>YOUR_MERLIN_HOME/agent/logs/launchagent.log</string>

    <key>StandardErrorPath</key>
    <string>YOUR_MERLIN_HOME/agent/logs/launchagent.err.log</string>
</dict>
</plist>
```

Replace `YOUR_MERLIN_HOME` with your absolute path (e.g. `/Users/alice/Dev/merlin`). The `node` path should match `which node`.

### 2. Pre-flight host setup

Some macOS settings make a real difference for an always-on host:

- **Auto-login** — System Settings → Users & Groups. The LaunchAgent needs a GUI session to use UI-permission tools.
- **Disable sleep**: `sudo pmset -a sleep 0 disksleep 0 displaysleep 180`. (Display can sleep; processes keep running.)
- **FileVault**: off, if you want auto-restart-after-power-cycle. (FileVault prompts for credentials at boot, blocking the GUI session.)
- **Hostname**: pick a stable one — `sudo scutil --set HostName myhost`. The agent's identity in launchd labels uses this.

### 3. Load and start

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.merlin.session.plist
launchctl kickstart gui/$(id -u)/ai.merlin.session
```

Verify it's running:

```bash
launchctl print gui/$(id -u)/ai.merlin.session | head -20
```

Look for `state = running` and a `pid = <number>`. Then check from the user side:

```bash
./bin/merlin status
```

### Stop / restart

```bash
# Stop just the inner claude child (supervisor stays up)
curl -X POST http://localhost:9093/restart   # ops
curl -X POST http://localhost:9094/restart   # chat

# Restart the whole tree
launchctl kickstart -k gui/$(id -u)/ai.merlin.session
```

### Heartbeat + resilience-test (optional)

If you want the periodic Firebase RTDB heartbeat or scheduled crash-recovery kill-tests, set up additional LaunchAgents. See `system/services.json` for the canonical list of labels and their corresponding scripts.

## Linux — systemd (user unit)

A systemd-user service runs as your user without root.

### 1. Create the unit file

Save to `~/.config/systemd/user/merlin.service`:

```ini
[Unit]
Description=Merlin agent OS
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Dev/merlin
Environment=MERLIN_HOME=%h/Dev/merlin
EnvironmentFile=%h/Dev/merlin/.env
ExecStart=/usr/bin/node %h/Dev/merlin/agent/bin/process-manager.mjs
Restart=always
RestartSec=5
StandardOutput=append:%h/Dev/merlin/agent/logs/systemd.log
StandardError=append:%h/Dev/merlin/agent/logs/systemd.err.log

[Install]
WantedBy=default.target
```

Adjust `WorkingDirectory` and `ExecStart` to match your clone location.

### 2. Pre-flight host setup

- **Lingering**: enable so the user service runs without you being logged in:
  ```bash
  loginctl enable-linger $(whoami)
  ```
- **Ollama**: install + enable as system service per Ollama's docs.
- **Tailscale or equivalent**: if you want to reach the host's wiki UI at `:9096` from elsewhere on your network.

### 3. Load and start

```bash
systemctl --user daemon-reload
systemctl --user enable merlin.service
systemctl --user start merlin.service

# Check
systemctl --user status merlin.service
journalctl --user -u merlin.service -f
```

### Stop / restart

```bash
systemctl --user restart merlin.service     # full restart (process-manager + all children)
curl -X POST http://localhost:9093/restart   # inner-child only (faster)
```

## Verifying it's working

After the service is running, dispatch a test job and watch it execute end-to-end:

```bash
./bin/merlin dispatch morning-digest
./bin/merlin tail ops
```

You should see the agent process the dispatch and either email the digest (if SMTP is wired) or just log the output. If the dispatch fails with `connection refused`, the supervisor isn't listening on :9092 — check that process-manager started cleanly.

## Updating

```bash
cd ~/Dev/merlin
git pull
./scripts/bootstrap.sh        # re-runs npm install + creates any new dirs

# macOS
launchctl kickstart -k gui/$(id -u)/ai.merlin.session

# Linux
systemctl --user restart merlin.service
```

For playbook-only changes (`agent/ops-agent/jobs/*.md`), no restart is needed — the supervisor reads the playbook fresh at each dispatch.

## Uninstall

### macOS
```bash
launchctl bootout gui/$(id -u)/ai.merlin.session
rm ~/Library/LaunchAgents/ai.merlin.session.plist
```

### Linux
```bash
systemctl --user stop merlin.service
systemctl --user disable merlin.service
rm ~/.config/systemd/user/merlin.service
```

Both leave the `~/Dev/merlin` clone untouched. Delete that directory separately to fully remove.
