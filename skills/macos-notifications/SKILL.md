---
name: macos-notifications
description: 'Sends a local macOS Notification Center alert. Use when the user invokes this skill to "send a notification", "notify me", "alert me", or send a "macOS notification" from the current task context.'
allowed-tools:
  - "Bash(terminal-notifier:*)"
  - "Bash(osascript:*)"
effort: low
user-invocable: true
disable-model-invocation: true
compatibility: Requires macOS. Uses terminal-notifier when installed, with the built-in osascript command as a fallback.
---

# macOS Notifications

Send one local Notification Center alert based on the current conversation. This does not send a remote push notification to another device.

## Send the notification

1. Derive a short title and message from the current task. Ask the user if the intended content is unclear.
2. Prefer `terminal-notifier`:

```bash
terminal-notifier \
  -title "Agent" \
  -message "Task completed successfully." \
  -sound default
```

3. If `terminal-notifier` is unavailable, use the built-in fallback:

```bash
osascript \
  -e 'on run argv' \
  -e 'display notification (item 1 of argv) with title (item 2 of argv) sound name "default"' \
  -e 'end run' \
  "Task completed successfully." \
  "Agent"
```

Replace the examples with the actual message and title. Keep every value as one quoted command argument. Never interpolate notification text into AppleScript source.

## Guardrails

- Send exactly one notification per invocation.
- Keep the message concise and omit secrets, tokens, private data, and long logs.
- Do not use `terminal-notifier` options that execute commands or open URLs.
- Report success only when the command exits with status 0.
- If delivery succeeds but no banner appears, tell the user to check macOS Notifications permissions and Focus settings.
- Do not install `terminal-notifier` without explicit approval. The `osascript` fallback requires no installation.
