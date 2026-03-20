#!/bin/bash
# Restart the Bridge gateway service (macOS launchd)
#
# Safe to run from a bot session — uses kickstart which restarts
# in-place without unloading the service definition.

LABEL="com.bridge"
DOMAIN="gui/$(id -u)"

if ! launchctl print "$DOMAIN/$LABEL" &>/dev/null; then
    echo "⚠️  Service not loaded. Loading from plist..."
    launchctl load ~/Library/LaunchAgents/$LABEL.plist 2>/dev/null || {
        echo "❌ Failed to load — is the plist installed?"
        exit 1
    }
    sleep 2
fi

launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || {
    echo "❌ kickstart failed"
    exit 1
}

sleep 2
if launchctl list | grep -q "$LABEL"; then
    echo "✅ Bridge restarted"
    tail -3 "$HOME/.bridge/bridge.log" 2>/dev/null
else
    echo "❌ Service not running after restart"
    tail -10 "$HOME/.bridge/bridge.log" 2>/dev/null
    exit 1
fi
