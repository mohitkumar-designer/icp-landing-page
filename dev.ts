import { watch } from "node:fs";
import { resolve, join } from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = resolve(".");

// Live reload SSE subscriber set
const clients = new Set<ReadableStreamDefaultController>();

// Watch project directory for changes
let reloadDebounce: Timer | null = null;
try {
  watch(ROOT_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const normalized = filename.replace(/\\/g, "/");
    // Ignore git, temp files, and node_modules
    if (
      normalized.startsWith(".git") ||
      normalized.startsWith(".vercel") ||
      normalized.includes("node_modules")
    ) {
      return;
    }

    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      console.log(`\x1b[35m[reload]\x1b[0m File changed: ${normalized} — refreshing browser...`);
      const msg = new TextEncoder().encode("data: reload\n\n");
      for (const client of clients) {
        try {
          client.enqueue(msg);
        } catch {
          clients.delete(client);
        }
      }
    }, 80);
  });
} catch (err) {
  console.warn("File watching warning:", err);
}

const liveReloadScript = `
<script>
  (() => {
    let es;
    function connect() {
      es = new EventSource('/__live_reload');
      es.onmessage = (event) => {
        if (event.data === 'reload') {
          console.log('[live-reload] Change detected, reloading page...');
          window.location.reload();
        }
      };
      es.onerror = () => {
        es.close();
        setTimeout(connect, 1000);
      };
    }
    connect();
  })();
</script>
`;

function serveFile(pathname: string) {
  let relativePath = decodeURIComponent(pathname);

  // Default routes and rewrites matching vercel.json
  if (relativePath === "/" || relativePath === "") {
    relativePath = "/index.html";
  } else if (relativePath === "/icp-landing") {
    relativePath = "/index.html";
  }

  // Prevent directory traversal
  const safePath = join(ROOT_DIR, relativePath);
  if (!safePath.startsWith(ROOT_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  return safePath;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // Live reload SSE endpoint
    if (url.pathname === "/__live_reload") {
      let clientController: ReadableStreamDefaultController;
      let pingInterval: Timer;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          clients.add(controller);
          controller.enqueue(new TextEncoder().encode("data: connected\n\n"));
          pingInterval = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
            } catch {
              clearInterval(pingInterval);
              clients.delete(controller);
            }
          }, 15000);
        },
        cancel() {
          clearInterval(pingInterval);
          if (clientController) clients.delete(clientController);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
        },
      });
    }

    const safeFilePath = serveFile(url.pathname);
    if (typeof safeFilePath !== "string") {
      return safeFilePath;
    }

    let file = Bun.file(safeFilePath);

    // If direct match doesn't exist, try appending .html
    if (!(await file.exists())) {
      const withHtml = Bun.file(`${safeFilePath}.html`);
      if (await withHtml.exists()) {
        file = withHtml;
      }
    }

    if (await file.exists()) {
      // Inject live reload script for HTML responses
      if (file.type && file.type.includes("text/html")) {
        const text = await file.text();
        const injected = text.includes("</body>")
          ? text.replace("</body>", `${liveReloadScript}\n</body>`)
          : text + liveReloadScript;
        return new Response(injected, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response(file, {
        headers: {
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("404 Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  },
});

console.log(`
  \x1b[36m⚡ Bun Dev Server\x1b[0m
  \x1b[32m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   http://localhost:${server.port}/
  \x1b[32m➜\x1b[0m  \x1b[1mLanding:\x1b[0m http://localhost:${server.port}/icp-landing
  \x1b[90m➜  Live Reload enabled & watching for changes...\x1b[0m
`);
