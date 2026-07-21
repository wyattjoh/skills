#!/usr/bin/env bun

/**
 * Mermaid diagram renderer -- reads mermaid code from stdin, generates an
 * interactive HTML file with pan/zoom support, writes it to /tmp, and opens it.
 */

const VALID_THEMES = ["default", "dark", "forest", "neutral"] as const;
type Theme = (typeof VALID_THEMES)[number];

/** Escape backticks and `${` sequences for safe embedding in a JS template literal. */
function escapeTemplateLiteral(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

export function generateHtml(mermaidCode: string, options?: { theme?: Theme }): string {
  const theme = options?.theme ?? "default";
  const escaped = escapeTemplateLiteral(mermaidCode);
  const isDark = theme === "dark";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mermaid Diagram</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: system-ui, -apple-system, sans-serif;
      background: ${isDark ? "#1a1a2e" : "#ffffff"};
      color: ${isDark ? "#e0e0e0" : "#333"};
    }
    #diagram-container {
      width: 100%;
      height: 90vh;
      border: 1px solid ${isDark ? "#444" : "#ddd"};
      overflow: hidden;
      position: relative;
    }
    svg {
      cursor: grab;
    }
    svg:active {
      cursor: grabbing;
    }
  </style>
</head>
<body>
  <div id="diagram-container"></div>

  <script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

    mermaid.initialize({ startOnLoad: false, theme: "${theme}" });

    const container = document.getElementById("diagram-container");
    const { svg } = await mermaid.render("mermaid-svg", \`${escaped}\`);

    // Remove max-width constraint so the SVG fills the container
    container.innerHTML = svg.replace(/max-width:[\\s]*[\\d\\.]*px;?/gi, "");

    const svgElement = container.querySelector("svg");
    svgElement.setAttribute("width", "100%");
    svgElement.setAttribute("height", "100%");

    svgPanZoom("#mermaid-svg", {
      zoomEnabled: true,
      controlIconsEnabled: true,
      fit: true,
      center: true,
      minZoom: 0.1,
      maxZoom: 10,
      zoomScaleSensitivity: 0.3,
      dblClickZoomEnabled: true,
      mouseWheelZoomEnabled: true,
      preventMouseEventsDefault: true,
    });
  </script>
</body>
</html>`;
}

function parseArgs(args: string[]): { theme: Theme; open: boolean } {
  let theme: Theme = "default";
  let open = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--theme" && i + 1 < args.length) {
      const value = args[i + 1];
      if (!VALID_THEMES.includes(value as Theme)) {
        console.error(`Invalid theme "${value}". Valid themes: ${VALID_THEMES.join(", ")}`);
        process.exit(1);
      }
      theme = value as Theme;
      i++;
    } else if (args[i] === "--no-open") {
      open = false;
    }
  }

  return { theme, open };
}

async function main(): Promise<void> {
  const { theme, open } = parseArgs(Bun.argv.slice(2));

  // Read mermaid code from stdin
  const code = (await Bun.stdin.text()).trim();

  if (!code) {
    console.error("Error: no mermaid code provided on stdin");
    process.exit(1);
  }

  const html = generateHtml(code, { theme });
  const filename = `mermaid-${crypto.randomUUID()}.html`;
  const filepath = `/tmp/${filename}`;

  await Bun.write(filepath, html);
  console.log(filepath);

  if (open) {
    Bun.spawn(["open", filepath]);
  }
}

if (import.meta.main) {
  main();
}
