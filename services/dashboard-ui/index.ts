import { APIGatewayProxyHandler } from 'aws-lambda';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pullmint Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&family=IBM+Plex+Mono:wght@400;600&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        --bg: #f6f2ea;
        --panel: #ffffff;
        --ink: #1d1b19;
        --muted: #6f6a63;
        --accent: #0b6b63;
        --accent-2: #d66b2d;
        --border: #e5ded5;
        --shadow: 0 10px 40px rgba(20, 15, 10, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Space Grotesk", sans-serif;
        color: var(--ink);
        background: radial-gradient(60% 60% at 10% 10%, #f0e4d6 0%, transparent 60%),
          radial-gradient(60% 60% at 90% 0%, #dfe7e4 0%, transparent 55%),
          var(--bg);
      }

      .frame {
        max-width: 1100px;
        margin: 0 auto;
        padding: 48px 20px 64px;
      }

      header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 24px;
      }

      h1 {
        margin: 0;
        font-size: 32px;
        letter-spacing: -0.02em;
      }

      .subtitle {
        color: var(--muted);
        font-size: 14px;
      }

      .controls {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto auto;
        gap: 12px;
        align-items: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
        box-shadow: var(--shadow);
      }

      .controls label {
        font-size: 12px;
        color: var(--muted);
        display: block;
        margin-bottom: 6px;
      }

      .controls input {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        font-family: "IBM Plex Mono", monospace;
        font-size: 13px;
      }

      .controls button {
        padding: 10px 16px;
        border-radius: 10px;
        border: none;
        background: var(--accent);
        color: white;
        font-weight: 600;
        cursor: pointer;
      }

      .controls button.secondary {
        background: transparent;
        color: var(--accent);
        border: 1px solid var(--accent);
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }

      .grid {
        margin-top: 20px;
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: 18px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px;
        box-shadow: var(--shadow);
      }

      .panel h2 {
        margin: 0 0 12px 0;
        font-size: 16px;
      }

      .list {
        display: grid;
        gap: 12px;
      }

      .item {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px;
        display: grid;
        gap: 6px;
        cursor: pointer;
      }

      .item.active {
        border-color: var(--accent);
        background: rgba(11, 107, 99, 0.06);
      }

      .pill {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        background: #f0ede7;
        color: var(--muted);
        margin-right: 6px;
      }

      .pill.accent {
        background: rgba(214, 107, 45, 0.1);
        color: var(--accent-2);
      }

      .muted {
        color: var(--muted);
        font-size: 12px;
      }

      .detail-grid {
        display: grid;
        gap: 10px;
        font-size: 14px;
      }

      .kv {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px dashed var(--border);
      }

      .kv:last-child {
        border-bottom: none;
      }

      @media (max-width: 900px) {
        header {
          flex-direction: column;
          align-items: flex-start;
        }

        .controls {
          grid-template-columns: 1fr;
        }

        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="frame">
      <header>
        <div>
          <h1>Pullmint Dashboard</h1>
          <div class="subtitle">Execution history and deployment status</div>
        </div>
        <div class="subtitle" id="lastUpdated">Last updated: never</div>
      </header>

      <section class="controls">
        <div>
          <label for="repoInput">Repository</label>
          <input id="repoInput" placeholder="owner/repo" />
        </div>
        <button id="loadBtn">Load</button>
        <button class="secondary" id="stopBtn">Pause polling</button>
        <div class="status" id="status">Idle</div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Executions</h2>
          <div class="list" id="executionList">No data yet</div>
        </div>
        <div class="panel">
          <h2>Details</h2>
          <div class="detail-grid" id="detail">Select an execution to view details</div>
        </div>
      </section>
    </div>

    <script>
      const apiBase = window.location.origin + "/dashboard";
      const listEl = document.getElementById("executionList");
      const detailEl = document.getElementById("detail");
      const statusEl = document.getElementById("status");
      const lastUpdatedEl = document.getElementById("lastUpdated");
      const loadBtn = document.getElementById("loadBtn");
      const stopBtn = document.getElementById("stopBtn");
      const repoInput = document.getElementById("repoInput");
      let selectedId = null;
      let pollHandle = null;

      const setStatus = (text) => {
        statusEl.textContent = text;
      };

      const formatTime = (timestamp) => {
        if (!timestamp) return "-";
        const date = new Date(timestamp);
        return date.toLocaleString();
      };

      const renderDetail = (item) => {
        if (!item) {
          detailEl.textContent = "Select an execution to view details";
          return;
        }

        detailEl.innerHTML = [
          '<div class="kv"><strong>Execution ID</strong><div>' + item.executionId + '</div></div>',
          '<div class="kv"><strong>Repository</strong><div>' + item.repoFullName + '</div></div>',
          '<div class="kv"><strong>PR</strong><div>#' + item.prNumber + '</div></div>',
          '<div class="kv"><strong>Status</strong><div>' + item.status + '</div></div>',
          '<div class="kv"><strong>Risk score</strong><div>' + (item.riskScore ?? '-') + '</div></div>',
          '<div class="kv"><strong>Deployment</strong><div>' + (item.deploymentStatus ?? '-') + '</div></div>',
          '<div class="kv"><strong>Environment</strong><div>' + (item.deploymentEnvironment ?? '-') + '</div></div>',
          '<div class="kv"><strong>Updated</strong><div>' + formatTime(item.updatedAt) + '</div></div>',
        ].join('');
      };

      const fetchJson = async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Request failed");
        }
        return response.json();
      };

      const loadDetail = async (executionId) => {
        try {
          const item = await fetchJson(
            apiBase + '/executions/' + encodeURIComponent(executionId)
          );
          renderDetail(item);
        } catch (error) {
          renderDetail(null);
        }
      };

      const renderList = (items) => {
        if (!items.length) {
          listEl.textContent = "No executions found";
          return;
        }

        listEl.innerHTML = "";
        items.forEach((item) => {
          const div = document.createElement("div");
          div.className = "item" + (item.executionId === selectedId ? " active" : "");
          div.innerHTML =
            '<div><span class="pill">' +
            item.status +
            '</span><span class="pill accent">risk ' +
            (item.riskScore ?? '-') +
            '</span></div>' +
            '<strong>#' +
            item.prNumber +
            ' ' +
            item.repoFullName +
            '</strong>' +
            '<div class="muted">' +
            item.executionId +
            '</div>';
          div.addEventListener("click", () => {
            selectedId = item.executionId;
            renderList(items);
            loadDetail(item.executionId);
          });
          listEl.appendChild(div);
        });
      };

      const loadList = async (repoFullName) => {
        if (!repoFullName) {
          return;
        }

        setStatus("Loading");
        try {
          const data = await fetchJson(
            apiBase + '/executions?repoFullName=' + encodeURIComponent(repoFullName)
          );
          renderList(data.items || []);
          lastUpdatedEl.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
          setStatus("Ready");
        } catch (error) {
          setStatus("Failed to load data");
        }
      };

      const startPolling = (repoFullName) => {
        if (pollHandle) {
          clearInterval(pollHandle);
        }
        pollHandle = setInterval(() => loadList(repoFullName), 8000);
      };

      loadBtn.addEventListener("click", () => {
        const repo = repoInput.value.trim();
        if (!repo) {
          setStatus("Enter a repository full name");
          return;
        }
        selectedId = null;
        renderDetail(null);
        loadList(repo);
        startPolling(repo);
      });

      stopBtn.addEventListener("click", () => {
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = null;
          setStatus("Polling paused");
        }
      });
    </script>
  </body>
</html>`;

export const handler: APIGatewayProxyHandler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
};
