---
name: screenshots
description: Captures application windows efficiently without interrupting the user's desktop. Use when asked to "take a screenshot", "capture the app window", "visually verify the UI", or build or start an app and capture its rendered state. Requires build, background launch, readiness waiting, and capture to run inside one script rather than as separate agent commands.
compatibility: Requires macOS and Screen Recording permission. Peekaboo is recommended; the built-in screencapture fallback requires a window ID.
---

# Screenshots

Treat screenshot capture as one atomic automation, not a sequence of model tool calls.

## Non-negotiable rule

Write one script that owns the complete operation:

1. Build the application if needed.
2. Start it without intentionally activating or focusing it.
3. Wait for its window to become capturable, retrying for at most one second.
4. Capture the exact window.
5. Clean up only processes or temporary files the script created.

Run that script with one command. Do not run a build or start command, return to the
agent, and then issue a separate screenshot command. The readiness wait and screenshot
command belong inside the same script that starts the app.

This keeps timing deterministic, minimizes how long the test app is open, and avoids
focus changes caused by a delayed second interaction.

## Preferred tool: Peekaboo

Use [Peekaboo](https://peekaboo.sh/) for macOS application windows. It can target an
app, PID, title, or exact window ID and ordinary observation does not activate the
target window.

Install it once:

```bash
brew install steipete/tap/peekaboo
```

For a raw screenshot, use `see` without accessibility elements:

```bash
peekaboo see --app "My App" --no-elements --path /tmp/my-app.png
```

Prefer an exact PID or window ID when several matching app windows can exist. Never add
`--foreground`, focus the window, synthesize a click, or use interactive screenshot
selection merely to make capture succeed.

## Script pattern

Use the target project's native scripting language. For Bun and TypeScript projects,
start with this pattern and replace the build, launch, target, and output values:

```typescript
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const output = ".scratch/screenshots/my-app.png";
const appPath = "/absolute/path/to/My App.app";
const appName = "My App";

const run = async (command: string[]): Promise<void> => {
  const process = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
};

await mkdir(dirname(output), { recursive: true });
await run(["bun", "run", "build"]);

// -g asks LaunchServices not to bring the application to the foreground.
await run(["open", "-g", "-n", appPath]);

const deadline = Date.now() + 1_000;
let lastError = "The window did not become capturable.";

while (Date.now() <= deadline) {
  const capture = Bun.spawn(
    ["peekaboo", "see", "--app", appName, "--no-elements", "--path", output],
    { stdout: "ignore", stderr: "pipe" },
  );
  const exitCode = await capture.exited;

  if (exitCode === 0) {
    console.log(output);
    process.exit(0);
  }

  lastError = (await new Response(capture.stderr).text()).trim() || lastError;
  await Bun.sleep(50);
}

throw new Error(`Screenshot failed within one second: ${lastError}`);
```

The retry loop is better than an unconditional one-second sleep. It captures as soon as
the window is ready while enforcing the one-second ceiling.

Keep build output and app logs out of the capture command's stdout when the caller needs
the script to print only the resulting image path. If the script directly spawns the
app executable and therefore owns its process, terminate that exact child in `finally`.
Do not quit an app by name when that could close a window the user already had open.

## Fallbacks

Use the narrowest fallback that fits the target:

- **Built-in macOS:** Resolve the app's CoreGraphics window ID inside the same script,
  then run `screencapture -x -o -l "$WINDOW_ID" "$OUTPUT"`. This adds no dependency,
  but window discovery is extra code and title matching can be ambiguous.
- **Custom macOS capture:** Use ScreenCaptureKit with
  `SCContentFilter(desktopIndependentWindow:)` and `SCScreenshotManager` when the
  project already has Swift capture infrastructure. Do not build this machinery for a
  one-off screenshot when Peekaboo is available.
- **Browser UI:** Use Playwright's page or locator screenshot API inside the same script
  that starts the server and waits for readiness. Do not capture the browser chrome
  unless that is the subject under test.
- **iOS Simulator:** Run `xcrun simctl io booted screenshot <path>` inside the same
  script that builds, installs, and launches the app.

Do not use interactive `screencapture -i` or `screencapture -w` for unattended work.
They require user input and can move focus.

## Protect the user's desktop

A background capture does not guarantee that a cold-launched application will stay in
the background. `open -g` requests nonactivation, but an application can activate
itself during startup. If the target ignores background launch behavior, do not keep
retrying against the user's active desktop. Use an isolated macOS login session, VM, CI
runner, simulator, or browser context instead.

Screen Recording permission must already be granted to the terminal or capture host.
Treat a missing permission as a setup error. Do not automate the permission dialog.
