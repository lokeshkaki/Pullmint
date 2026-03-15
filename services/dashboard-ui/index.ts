import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * Dashboard UI Handler
 * Serves the static HTML dashboard application
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log('Dashboard UI request:', { path: event.path, method: event.httpMethod });

  // Only support GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Method not allowed',
    };
  }

  const html = await Promise.resolve(getDashboardHTML());

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: html,
  };
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pullmint Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    header {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      margin-bottom: 30px;
    }

    h1 {
      color: #667eea;
      font-size: 32px;
      margin-bottom: 10px;
    }

    .subtitle {
      color: #666;
      font-size: 16px;
    }

    .filters {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      margin-bottom: 20px;
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      align-items: center;
    }

    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .filter-group label {
      font-size: 12px;
      color: #666;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    input, select, button {
      padding: 10px 15px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
    }

    input:focus, select:focus {
      outline: none;
      border-color: #667eea;
    }

    button {
      background: #667eea;
      color: white;
      border: none;
      cursor: pointer;
      font-weight: 500;
      transition: background 0.2s;
    }

    button:hover {
      background: #5568d3;
    }

    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    .stat-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #333;
    }

    .executions {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .executions-header {
      padding: 20px;
      border-bottom: 2px solid #f0f0f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .executions-header h2 {
      color: #333;
      font-size: 20px;
    }

    .refresh-btn {
      padding: 8px 16px;
      font-size: 13px;
    }

    .execution-list {
      max-height: 600px;
      overflow-y: auto;
    }

    .execution-item {
      padding: 20px;
      border-bottom: 1px solid #f0f0f0;
      transition: background 0.2s;
      cursor: pointer;
    }

    .execution-item:hover {
      background: #f9f9f9;
    }

    .execution-item:last-child {
      border-bottom: none;
    }

    .execution-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 10px;
    }

    .execution-title {
      font-weight: 600;
      color: #333;
      font-size: 16px;
    }

    .execution-meta {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      font-size: 13px;
      color: #666;
      margin-bottom: 10px;
    }

    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .badge.pending { background: #fff3cd; color: #856404; }
    .badge.analyzing { background: #cce5ff; color: #004085; }
    .badge.completed { background: #d4edda; color: #155724; }
    .badge.failed { background: #f8d7da; color: #721c24; }
    .badge.deploying { background: #d1ecf1; color: #0c5460; }
    .badge.deployed { background: #d4edda; color: #155724; }
    .badge.monitoring { background: #e2d9f3; color: #4a1f8c; }
    .badge.confirmed { background: #d4edda; color: #155724; }
    .badge.rolled-back { background: #f8d7da; color: #721c24; }
    .badge.deployment-blocked { background: #f8d7da; color: #721c24; }

    .nav-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }

    .nav-tab {
      padding: 10px 20px;
      border-radius: 8px;
      border: 2px solid transparent;
      background: rgba(255,255,255,0.3);
      color: white;
      font-weight: 600;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }

    .nav-tab:hover { background: rgba(255,255,255,0.5); }
    .nav-tab.active { background: white; color: #667eea; border-color: white; }

    .risk-board {
      display: flex;
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 10px;
    }

    .board-column {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      min-width: 220px;
      flex: 1;
      overflow: hidden;
    }

    .board-column.hold-column { border-top: 4px solid #f8c200; }

    .board-column-header {
      padding: 14px 16px;
      font-weight: 700;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: #f9f9f9;
      border-bottom: 1px solid #eee;
      color: #555;
    }

    .board-cards {
      padding: 10px;
      min-height: 80px;
    }

    .board-card {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: box-shadow 0.2s;
    }

    .board-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }

    .board-card-title {
      font-weight: 600;
      font-size: 13px;
      color: #333;
      margin-bottom: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .board-card-meta {
      font-size: 12px;
      color: #888;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .confidence-bar {
      height: 4px;
      background: #eee;
      border-radius: 2px;
      margin-top: 6px;
      overflow: hidden;
    }

    .confidence-bar-fill {
      height: 100%;
      background: #667eea;
      border-radius: 2px;
    }

    .checkpoint-timeline {
      display: flex;
      align-items: center;
      gap: 0;
      padding: 20px 0;
      overflow-x: auto;
    }

    .checkpoint-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 120px;
      cursor: pointer;
    }

    .checkpoint-node-dot {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #ccc;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: white;
      z-index: 1;
    }

    .checkpoint-node--approved .checkpoint-node-dot { background: #28a745; }
    .checkpoint-node--held .checkpoint-node-dot { background: #f8c200; }
    .checkpoint-node--rollback .checkpoint-node-dot { background: #dc3545; }
    .checkpoint-node--pending .checkpoint-node-dot { background: #ccc; }
    .checkpoint-node--active .checkpoint-node-dot { animation: pulse 1.5s infinite; }

    @keyframes pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(102,126,234,0.4); }
      50% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(102,126,234,0); }
    }

    .checkpoint-node-label {
      font-size: 11px;
      color: #666;
      text-align: center;
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .checkpoint-connector {
      flex: 1;
      height: 2px;
      background: #e0e0e0;
      min-width: 20px;
    }

    .checkpoint-detail {
      background: #f9f9f9;
      border-radius: 8px;
      padding: 16px;
      margin-top: 10px;
      font-size: 13px;
    }

    .signal-coverage {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      padding: 20px;
      margin-top: 16px;
    }

    .signal-row {
      display: flex;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
    }

    .signal-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 10px;
      flex-shrink: 0;
    }

    .signal-dot.received { background: #28a745; }
    .signal-dot.missing { background: #dee2e6; }

    .calibration-panel {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .calibration-table {
      width: 100%;
      border-collapse: collapse;
    }

    .calibration-table th {
      padding: 12px 16px;
      text-align: left;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
      background: #f9f9f9;
      border-bottom: 2px solid #eee;
    }

    .calibration-table td {
      padding: 12px 16px;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
    }

    .calibration-table tr:hover td { background: #f9f9f9; cursor: pointer; }

    .factor-inactive { color: #bbb; font-style: italic; }
    .factor-high { color: #dc3545; font-weight: 600; }
    .factor-low { color: #28a745; font-weight: 600; }

    .action-bar {
      display: flex;
      gap: 10px;
      padding: 12px 0;
    }

    .btn-override {
      background: #ffc107;
      color: #333;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }

    .btn-override:hover { background: #e0a800; }

    .btn-copy {
      background: #6c757d;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }

    .btn-copy:hover { background: #5a6268; }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.open { display: flex; }

    .modal {
      background: white;
      border-radius: 12px;
      padding: 24px;
      max-width: 480px;
      width: 90%;
    }

    .modal h3 { margin-bottom: 12px; color: #333; }
    .modal textarea {
      width: 100%;
      min-height: 80px;
      padding: 10px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
    }

    .modal-actions {
      display: flex;
      gap: 10px;
      margin-top: 12px;
      justify-content: flex-end;
    }

    .risk-score {
      font-weight: bold;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 14px;
    }

    .risk-low { background: #d4edda; color: #155724; }
    .risk-medium { background: #fff3cd; color: #856404; }
    .risk-high { background: #f8d7da; color: #721c24; }

    .findings {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #f0f0f0;
    }

    .finding-item {
      padding: 8px 12px;
      margin: 5px 0;
      border-left: 4px solid #667eea;
      background: #f9f9f9;
      border-radius: 4px;
      font-size: 13px;
    }

    .finding-severity {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      margin-right: 8px;
    }

    .finding-severity.critical { color: #721c24; }
    .finding-severity.high { color: #856404; }
    .finding-severity.medium { color: #0c5460; }
    .finding-severity.low { color: #155724; }

    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }

    .error {
      background: #f8d7da;
      color: #721c24;
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
    }

    .empty {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }

    .load-more {
      padding: 15px;
      text-align: center;
      border-top: 2px solid #f0f0f0;
    }

    .deployment-timeline {
      margin-top: 10px;
      padding: 10px;
      background: #f9f9f9;
      border-radius: 6px;
      font-size: 12px;
    }

    .timeline-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 0;
      color: #666;
    }

    .timeline-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #667eea;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Pullmint Dashboard</h1>
      <p class="subtitle">AI-powered pull request analysis and deployment automation</p>
    </header>

    <nav class="nav-tabs">
      <button class="nav-tab active" onclick="showView('executions-view', this)">Executions</button>
      <button class="nav-tab" onclick="showView('board-view', this)">Risk Board</button>
      <button class="nav-tab" onclick="showView('calibration-view', this)">Calibration</button>
    </nav>

    <div id="executions-view">

    <div class="filters">
      <div class="filter-group">
        <label>Repository</label>
        <input type="text" id="repoFilter" placeholder="owner/repo">
      </div>
      <div class="filter-group">
        <label>Status</label>
        <select id="statusFilter">
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="analyzing">Analyzing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="deploying">Deploying</option>
          <option value="deployed">Deployed</option>
        </select>
      </div>
      <div class="filter-group">
        <label>&nbsp;</label>
        <button onclick="applyFilters()">Apply Filters</button>
      </div>
      <div class="filter-group">
        <label>&nbsp;</label>
        <button onclick="clearFilters()">Clear</button>
      </div>
    </div>

    <div class="stats" id="stats">
      <div class="stat-card">
        <div class="stat-label">Total Executions</div>
        <div class="stat-value" id="totalCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Risk Score</div>
        <div class="stat-value" id="avgRisk">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Auto-Deployed</div>
        <div class="stat-value" id="deployedCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Success Rate</div>
        <div class="stat-value" id="successRate">-</div>
      </div>
    </div>

    <div class="executions">
      <div class="executions-header">
        <h2>Recent Executions</h2>
        <button class="refresh-btn" onclick="loadExecutions()">Refresh</button>
      </div>
      <div id="executionList" class="execution-list">
        <div class="loading">Loading executions...</div>
        <div class="error" style="display: none;"></div>
        <div class="empty" style="display: none;"></div>
      </div>
    </div>

    </div><!-- /#executions-view -->

    <!-- Risk Board view -->
    <div id="board-view" style="display:none">
      <div style="background:white;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);padding:20px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="color:#333;font-size:20px;">Risk Board</h2>
          <button class="refresh-btn" onclick="loadBoard()">Refresh</button>
        </div>
        <div id="boardStats" style="display:flex;gap:20px;margin-bottom:16px;font-size:13px;color:#666;"></div>
      </div>
      <div id="boardContainer" class="risk-board">
        <div class="loading">Loading board...</div>
      </div>
    </div>

    <!-- Execution Detail view -->
    <div id="detail-view" style="display:none">
      <button onclick="showView('board-view', null)" style="margin-bottom:16px;background:rgba(255,255,255,0.3);color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;">← Back to Board</button>
      <div style="background:white;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);padding:24px;">
        <h2 id="detailTitle" style="color:#333;font-size:20px;margin-bottom:20px;">Execution Detail</h2>
        <div id="checkpointTimeline" class="checkpoint-timeline"></div>
        <div id="checkpointDetail" class="checkpoint-detail" style="display:none;"></div>
        <div id="repoContextPanel" style="margin-top:20px;"></div>
        <div id="signalCoverage" class="signal-coverage" style="margin-top:16px;display:none;">
          <h3 style="font-size:15px;color:#333;margin-bottom:12px;">Signal Coverage</h3>
          <div id="signalList"></div>
        </div>
        <div class="action-bar" style="margin-top:16px;">
          <button class="btn-override" id="overrideBtn" onclick="openJustificationModal()">Override</button>
          <button class="btn-copy" onclick="copyDeepLink()">Copy Link</button>
        </div>
      </div>
    </div>

    <!-- Calibration view -->
    <div id="calibration-view" style="display:none">
      <div class="calibration-panel">
        <div style="padding:20px;border-bottom:2px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="color:#333;font-size:20px;">Calibration Panel</h2>
          <button class="refresh-btn" onclick="loadCalibration()">Refresh</button>
        </div>
        <div id="calibrationContainer">
          <div class="loading">Loading calibration data...</div>
        </div>
      </div>
    </div>

    <!-- Justification modal for Override action -->
    <div class="modal-overlay" id="justificationModal">
      <div class="modal">
        <h3>Override Justification</h3>
        <textarea id="justificationText" placeholder="Explain why you are overriding the deployment gate..."></textarea>
        <div class="modal-actions">
          <button onclick="closeJustificationModal()" style="background:#6c757d;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Cancel</button>
          <button onclick="submitOverride()" style="background:#667eea;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;">Submit Override</button>
        </div>
      </div>
    </div>

  </div><!-- /.container -->

  <script>
    const dashboardPath = '/dashboard';
    const dashboardIndex = window.location.pathname.indexOf(dashboardPath);
    const apiBase =
      window.location.origin +
      (dashboardIndex >= 0
        ? window.location.pathname.slice(0, dashboardIndex + dashboardPath.length)
        : dashboardPath);
    let currentFilters = {};
    let nextToken = null;
    let pollingInterval = null;

    function getAuthHeaders() {
      const token = window.localStorage?.getItem('dashboardAuthToken');
      return token ? { Authorization: 'Bearer ' + token } : {};
    }

    async function loadExecutions(append = false) {
      try {
        const params = new URLSearchParams(currentFilters);
        if (append && nextToken) {
          params.set('nextToken', nextToken);
        }

        const response = await fetch(\`\${apiBase}/executions?\${params}\`, {
          headers: getAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to fetch executions');

        const data = await response.json();
        
        if (!append) {
          updateStats(data.executions);
        }

        renderExecutions(data.executions, append);
        nextToken = data.nextToken;

        // Show/hide load more button
        const loadMoreBtn = document.querySelector('.load-more');
        if (nextToken && !loadMoreBtn) {
          const btn = document.createElement('div');
          btn.className = 'load-more';
          const button = document.createElement('button');
          button.textContent = 'Load More';
          button.onclick = () => loadExecutions(true);
          btn.appendChild(button);
          document.getElementById('executionList').appendChild(btn);
        } else if (!nextToken && loadMoreBtn) {
          loadMoreBtn.remove();
        }

      } catch (error) {
        console.error('Error loading executions:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        const container = document.getElementById('executionList');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error';
        errorDiv.textContent = 'Error loading executions: ' + message;
        container.replaceChildren(errorDiv);
      }
    }

    function renderExecutions(executions, append = false) {
      const container = document.getElementById('executionList');

      if (!append) {
        container.innerHTML = '';
      } else {
        // Remove loading or empty messages
        const loadMore = container.querySelector('.load-more');
        if (loadMore) loadMore.remove();
      }

      if (executions.length === 0 && !append) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty';
        emptyDiv.textContent = 'No executions found';
        container.appendChild(emptyDiv);
        return;
      }

      executions.forEach(exec => {
        const item = document.createElement('div');
        item.className = 'execution-item';
        item.onclick = () => viewExecution(exec.executionId);

        const timestamp = exec.timestamp ? new Date(exec.timestamp).toLocaleString() : 'Unknown';
        const riskClass = getRiskClass(exec.riskScore);
        const headSha = exec.headSha ? exec.headSha.substring(0, 7) : 'unknown';

        const header = document.createElement('div');
        header.className = 'execution-header';

        const title = document.createElement('div');
        title.className = 'execution-title';
        title.textContent = exec.repoFullName + ' #' + exec.prNumber;

        const statusBadge = document.createElement('span');
        statusBadge.className = 'badge ' + exec.status;
        statusBadge.textContent = exec.status;

        header.appendChild(title);
        header.appendChild(statusBadge);

        const meta = document.createElement('div');
        meta.className = 'execution-meta';

        const timeSpan = document.createElement('span');
        timeSpan.textContent = '📅 ' + timestamp;

        const shaSpan = document.createElement('span');
        shaSpan.textContent = '🔗 ' + headSha;

        meta.appendChild(timeSpan);
        meta.appendChild(shaSpan);

        if (exec.riskScore !== undefined) {
          const riskSpan = document.createElement('span');
          riskSpan.className = 'risk-score ' + riskClass;
          riskSpan.textContent = 'Risk: ' + exec.riskScore;
          meta.appendChild(riskSpan);
        }

        item.appendChild(header);
        item.appendChild(meta);

        if (exec.findings && exec.findings.length > 0) {
          const findingsNode = renderFindings(exec.findings);
          if (findingsNode) {
            item.appendChild(findingsNode);
          }
        }

        if (exec.deploymentStatus) {
          const deploymentNode = renderDeployment(exec);
          if (deploymentNode) {
            item.appendChild(deploymentNode);
          }
        }

        container.appendChild(item);
      });
    }

    function renderFindings(findings) {
      const criticalAndHigh = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
      if (criticalAndHigh.length === 0) return '';

      const findingsContainer = document.createElement('div');
      findingsContainer.className = 'findings';

      const title = document.createElement('strong');
      title.textContent = 'Key Findings:';
      findingsContainer.appendChild(title);

      criticalAndHigh.slice(0, 3).forEach(finding => {
        const item = document.createElement('div');
        item.className = 'finding-item';

        const severity = document.createElement('span');
        severity.className = 'finding-severity ' + finding.severity;
        severity.textContent = finding.severity;

        const text = document.createElement('span');
        text.textContent = ' ' + finding.title;

        item.appendChild(severity);
        item.appendChild(text);
        findingsContainer.appendChild(item);
      });

      if (findings.length > 3) {
        const more = document.createElement('div');
        more.style.fontSize = '12px';
        more.style.color = '#666';
        more.style.marginTop = '5px';
        more.textContent = '+' + (findings.length - 3) + ' more findings';
        findingsContainer.appendChild(more);
      }

      return findingsContainer;
    }

    function renderDeployment(exec) {
      const timeline = document.createElement('div');
      timeline.className = 'deployment-timeline';

      const environmentItem = document.createElement('div');
      environmentItem.className = 'timeline-item';
      const environmentDot = document.createElement('div');
      environmentDot.className = 'timeline-dot';
      const environmentText = document.createElement('span');
      environmentText.textContent =
        'Environment: ' + (exec.deploymentEnvironment || 'staging');
      environmentItem.appendChild(environmentDot);
      environmentItem.appendChild(environmentText);
      timeline.appendChild(environmentItem);

      const statusItem = document.createElement('div');
      statusItem.className = 'timeline-item';
      const statusDot = document.createElement('div');
      statusDot.className = 'timeline-dot';
      const statusText = document.createElement('span');
      statusText.textContent = 'Status: ' + exec.deploymentStatus;
      statusItem.appendChild(statusDot);
      statusItem.appendChild(statusText);
      timeline.appendChild(statusItem);

      if (exec.deploymentCompletedAt) {
        const completedItem = document.createElement('div');
        completedItem.className = 'timeline-item';
        const completedDot = document.createElement('div');
        completedDot.className = 'timeline-dot';
        const completedText = document.createElement('span');
        completedText.textContent =
          'Completed: ' + new Date(exec.deploymentCompletedAt).toLocaleString();
        completedItem.appendChild(completedDot);
        completedItem.appendChild(completedText);
        timeline.appendChild(completedItem);
      }

      return timeline;
    }

    function getRiskClass(score) {
      if (score === undefined) return '';
      if (score < 30) return 'risk-low';
      if (score < 60) return 'risk-medium';
      return 'risk-high';
    }

    function updateStats(executions) {
      const total = executions.length;
      document.getElementById('totalCount').textContent = total;

      if (total > 0) {
        const scoredExecutions = executions.filter(e => e.riskScore !== undefined);
        const scoredCount = scoredExecutions.length;

        if (scoredCount > 0) {
          const avgRisk =
            scoredExecutions.reduce((sum, e) => sum + e.riskScore, 0) / scoredCount;
          document.getElementById('avgRisk').textContent = avgRisk.toFixed(1);
        } else {
          document.getElementById('avgRisk').textContent = '-';
        }

        const deployed = executions.filter(e => e.deploymentStatus === 'deployed').length;
        document.getElementById('deployedCount').textContent = deployed;

        const completed = executions.filter(e => e.status === 'completed' || e.status === 'deployed').length;
        const successRate = ((completed / total) * 100).toFixed(1);
        document.getElementById('successRate').textContent = successRate + '%';
      }
    }

    function applyFilters() {
      const repo = document.getElementById('repoFilter').value.trim();
      const status = document.getElementById('statusFilter').value;

      currentFilters = {};
      if (repo) currentFilters.repo = repo;
      if (status) currentFilters.status = status;

      nextToken = null;
      loadExecutions();
    }

    function clearFilters() {
      document.getElementById('repoFilter').value = '';
      document.getElementById('statusFilter').value = '';
      currentFilters = {};
      nextToken = null;
      loadExecutions();
    }

    async function viewExecution(executionId) {
      try {
        const response = await fetch(\`\${apiBase}/executions/\${executionId}\`, {
          headers: getAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to fetch execution details');
        
        const exec = await response.json();
        console.log('Execution details:', exec);
        
        // Could open a modal or navigate to detail page
        alert(\`Execution ID: \${exec.executionId}\\nStatus: \${exec.status}\\nRisk Score: \${exec.riskScore || 'N/A'}\\nFindings: \${exec.findings?.length || 0}\`);
      } catch (error) {
        console.error('Error fetching execution:', error);
        alert('Error loading execution details');
      }
    }

    // Auto-refresh every 10 seconds
    function startPolling() {
      pollingInterval = setInterval(() => {
        loadExecutions();
      }, 10000);
    }

    function stopPolling() {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    }

    // Initialize
    loadExecutions();
    startPolling();

    // Stop polling when page is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    });

    // ===========================
    // View navigation
    // ===========================
    let activeViewBtn = document.querySelector('.nav-tab.active');

    function showView(viewId, btn) {
      ['executions-view', 'board-view', 'detail-view', 'calibration-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      const view = document.getElementById(viewId);
      if (view) view.style.display = '';

      if (activeViewBtn) activeViewBtn.classList.remove('active');
      if (btn) { btn.classList.add('active'); activeViewBtn = btn; }

      if (viewId === 'board-view') loadBoard();
      if (viewId === 'calibration-view') loadCalibration();
    }

    // ===========================
    // Risk Board
    // ===========================
    let boardPollingInterval = null;

    async function loadBoard() {
      const container = document.getElementById('boardContainer');
      container.innerHTML = '<div class="loading">Loading board...</div>';
      try {
        const response = await fetch(\`\${apiBase}/board\`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('Failed to fetch board');
        const data = await response.json();
        renderBoard(data.board);
        updateBoardStats(data.board);
      } catch (error) {
        container.innerHTML = '<div class="error">Failed to load board: ' + (error instanceof Error ? error.message : 'Unknown error') + '</div>';
      }
    }

    function updateBoardStats(board) {
      const statsEl = document.getElementById('boardStats');
      const active = (board.deploying || []).length + (board.monitoring || []).length;
      const held = (board.completed || []).length;
      const rolled = (board['rolled-back'] || []).length;
      statsEl.innerHTML =
        '<span><strong>' + active + '</strong> active</span>' +
        '<span><strong>' + held + '</strong> held</span>' +
        '<span><strong>' + rolled + '</strong> rollbacks (24h)</span>';
    }

    const BOARD_COLUMNS = [
      { key: 'analyzing', label: 'Analyzing', hold: false },
      { key: 'completed', label: 'Pre-Deploy Hold', hold: true },
      { key: 'deploying', label: 'Deploying', hold: false },
      { key: 'monitoring', label: 'Monitoring', hold: false },
      { key: 'confirmed', label: 'Confirmed', hold: false },
      { key: 'rolled-back', label: 'Rolled Back', hold: false },
    ];

    function renderBoard(board) {
      const container = document.getElementById('boardContainer');
      container.innerHTML = '';

      BOARD_COLUMNS.forEach(col => {
        const cards = board[col.key] || [];
        const column = document.createElement('div');
        column.className = 'board-column' + (col.hold ? ' hold-column' : '');

        const header = document.createElement('div');
        header.className = 'board-column-header';
        header.textContent = col.label + ' (' + cards.length + ')';
        column.appendChild(header);

        const cardContainer = document.createElement('div');
        cardContainer.className = 'board-cards';

        if (cards.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'color:#bbb;font-size:12px;text-align:center;padding:16px;';
          empty.textContent = 'No deployments';
          cardContainer.appendChild(empty);
        }

        cards.forEach(card => {
          const el = document.createElement('div');
          el.className = 'board-card';
          el.onclick = () => showExecutionDetail(card.executionId);

          const title = document.createElement('div');
          title.className = 'board-card-title';
          title.textContent = card.repoFullName + ' #' + card.prNumber;
          el.appendChild(title);

          const meta = document.createElement('div');
          meta.className = 'board-card-meta';

          const authorSpan = document.createElement('span');
          authorSpan.textContent = card.author || '';
          meta.appendChild(authorSpan);

          if (card.riskScore !== undefined) {
            const riskSpan = document.createElement('span');
            const riskClass = getRiskClass(card.riskScore);
            riskSpan.className = 'risk-score ' + riskClass;
            riskSpan.style.cssText = 'padding:2px 6px;font-size:11px;';
            riskSpan.textContent = 'Risk: ' + card.riskScore;
            meta.appendChild(riskSpan);
          }

          el.appendChild(meta);

          if (card.confidenceScore !== undefined) {
            const bar = document.createElement('div');
            bar.className = 'confidence-bar';
            const fill = document.createElement('div');
            fill.className = 'confidence-bar-fill';
            fill.style.width = Math.round(card.confidenceScore * 100) + '%';
            bar.appendChild(fill);
            el.appendChild(bar);
          }

          cardContainer.appendChild(el);
        });

        column.appendChild(cardContainer);
        container.appendChild(column);
      });
    }

    // ===========================
    // Execution Detail
    // ===========================
    let currentExecutionId = null;

    async function showExecutionDetail(executionId) {
      currentExecutionId = executionId;
      showView('detail-view', null);
      document.getElementById('detailTitle').textContent = 'Execution: ' + executionId;
      document.getElementById('checkpointTimeline').innerHTML = '<div class="loading">Loading...</div>';
      document.getElementById('checkpointDetail').style.display = 'none';

      try {
        const response = await fetch(\`\${apiBase}/executions/\${executionId}/checkpoints\`, {
          headers: getAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to fetch checkpoint data');
        const data = await response.json();
        renderTimeline(data.checkpoints);
        renderRepoContext(data.repoContext);
        renderSignalCoverage(data.signalsReceived);
      } catch (error) {
        document.getElementById('checkpointTimeline').innerHTML =
          '<div class="error">Failed to load: ' + (error instanceof Error ? error.message : 'Unknown error') + '</div>';
      }
    }

    const CHECKPOINT_TYPES = ['analysis', 'pre-deploy', 'post-deploy-5', 'post-deploy-30'];
    const CHECKPOINT_LABELS = { 'analysis': 'Analysis', 'pre-deploy': 'Pre-Deploy', 'post-deploy-5': 'T+5min', 'post-deploy-30': 'T+30min' };

    function renderTimeline(checkpoints) {
      const container = document.getElementById('checkpointTimeline');
      container.innerHTML = '';

      const completedTypes = new Set(checkpoints.map(c => c.type));

      CHECKPOINT_TYPES.forEach((type, i) => {
        if (i > 0) {
          const connector = document.createElement('div');
          connector.className = 'checkpoint-connector';
          container.appendChild(connector);
        }

        const cp = checkpoints.find(c => c.type === type);
        const node = document.createElement('div');

        let stateClass = 'checkpoint-node--pending';
        if (cp) {
          if (cp.decision === 'approved') stateClass = 'checkpoint-node--approved';
          else if (cp.decision === 'rollback') stateClass = 'checkpoint-node--rollback';
          else stateClass = 'checkpoint-node--held';
        } else if (i === completedTypes.size) {
          stateClass = 'checkpoint-node--active';
        }

        node.className = 'checkpoint-node ' + stateClass;
        node.onclick = () => showCheckpointDetail(cp);

        const dot = document.createElement('div');
        dot.className = 'checkpoint-node-dot';
        dot.textContent = cp ? (cp.decision === 'approved' ? '✓' : cp.decision === 'rollback' ? '✗' : '!') : (i + 1).toString();
        node.appendChild(dot);

        const label = document.createElement('div');
        label.className = 'checkpoint-node-label';
        label.textContent = CHECKPOINT_LABELS[type] || type;
        node.appendChild(label);

        if (cp) {
          const score = document.createElement('div');
          score.style.cssText = 'font-size:11px;color:#888;margin-top:3px;';
          score.textContent = 'Score: ' + cp.score;
          node.appendChild(score);
        }

        container.appendChild(node);
      });
    }

    function showCheckpointDetail(cp) {
      const detailEl = document.getElementById('checkpointDetail');
      if (!cp) { detailEl.style.display = 'none'; return; }
      detailEl.style.display = '';
      detailEl.innerHTML =
        '<strong>' + (CHECKPOINT_LABELS[cp.type] || cp.type) + '</strong>' +
        '<p style="margin-top:8px;color:#333;">' + (cp.reason || 'No reason provided.') + '</p>' +
        '<p style="margin-top:6px;color:#888;font-size:12px;">Score: ' + cp.score +
        ' &nbsp;|&nbsp; Confidence: ' + (cp.confidence != null ? Math.round(cp.confidence * 100) + '%' : 'N/A') +
        ' &nbsp;|&nbsp; Decision: <strong>' + cp.decision + '</strong></p>';
    }

    function renderRepoContext(repoContext) {
      const panel = document.getElementById('repoContextPanel');
      if (!repoContext) { panel.innerHTML = ''; return; }
      panel.innerHTML =
        '<div style="background:white;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);padding:16px;margin-top:16px;">' +
        '<h3 style="font-size:15px;color:#333;margin-bottom:10px;">Repo Context</h3>' +
        '<div style="font-size:13px;color:#555;line-height:1.8;">' +
        '<div>Blast radius multiplier: <strong>' + (repoContext.blastRadiusMultiplier || 1.0).toFixed(2) + 'x</strong></div>' +
        '<div>Downstream dependents: <strong>' + (repoContext.downstreamDependentCount || 0) + '</strong></div>' +
        '<div>30-day rollback rate: <strong>' + (repoContext.repoRollbackRate30d != null ? (repoContext.repoRollbackRate30d * 100).toFixed(1) + '%' : 'N/A') + '</strong></div>' +
        '</div></div>';
    }

    function renderSignalCoverage(signalsReceived) {
      const panel = document.getElementById('signalCoverage');
      const list = document.getElementById('signalList');
      if (!signalsReceived || Object.keys(signalsReceived).length === 0) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = '';
      list.innerHTML = '';
      Object.entries(signalsReceived).forEach(([key, sig]) => {
        const row = document.createElement('div');
        row.className = 'signal-row';
        const dot = document.createElement('div');
        dot.className = 'signal-dot received';
        const label = document.createElement('span');
        label.textContent = key + ' — ' + sig.source + ' (' + new Date(sig.receivedAt).toLocaleString() + ')';
        row.appendChild(dot);
        row.appendChild(label);
        list.appendChild(row);
      });
    }

    // ===========================
    // Override / Re-evaluate
    // ===========================
    function openJustificationModal() {
      document.getElementById('justificationModal').classList.add('open');
    }

    function closeJustificationModal() {
      document.getElementById('justificationModal').classList.remove('open');
      document.getElementById('justificationText').value = '';
    }

    async function submitOverride() {
      const justification = document.getElementById('justificationText').value.trim();
      if (!currentExecutionId) return;
      try {
        const response = await fetch(\`\${apiBase}/executions/\${currentExecutionId}/re-evaluate\`, {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ justification }),
        });
        closeJustificationModal();
        if (response.status === 429) {
          alert('Rate limit: please wait 2 minutes before re-evaluating again.');
        } else if (!response.ok) {
          alert('Override failed. Please try again.');
        } else {
          alert('Override logged successfully.');
        }
      } catch (error) {
        alert('Override failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    }

    function copyDeepLink() {
      if (navigator.clipboard && currentExecutionId) {
        navigator.clipboard.writeText(window.location.origin + window.location.pathname + '?exec=' + currentExecutionId);
        alert('Link copied!');
      }
    }

    // ===========================
    // Calibration Panel
    // ===========================
    async function loadCalibration() {
      const container = document.getElementById('calibrationContainer');
      container.innerHTML = '<div class="loading">Loading calibration data...</div>';
      try {
        const response = await fetch(\`\${apiBase}/calibration\`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('Failed to fetch calibration data');
        const data = await response.json();
        renderCalibration(data.repos);
      } catch (error) {
        container.innerHTML = '<div class="error">Failed to load calibration: ' + (error instanceof Error ? error.message : 'Unknown error') + '</div>';
      }
    }

    function renderCalibration(repos) {
      const container = document.getElementById('calibrationContainer');

      if (!repos || repos.length === 0) {
        container.innerHTML = '<div class="empty">No calibration data yet. Calibration begins after 10 deployments per repo.</div>';
        return;
      }

      const table = document.createElement('table');
      table.className = 'calibration-table';

      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Repo</th><th>Deployments</th><th>Success Rate</th><th>Calibration Factor</th></tr>';
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      repos.forEach(repo => {
        const tr = document.createElement('tr');
        tr.onclick = () => loadCalibrationDetail(repo.repoFullName);

        const isActive = (repo.observationsCount || 0) >= 10;
        const successRate = repo.totalDeployments > 0
          ? ((repo.successCount / repo.totalDeployments) * 100).toFixed(1) + '%'
          : 'N/A';
        const factorClass = !isActive ? 'factor-inactive'
          : repo.calibrationFactor > 1.1 ? 'factor-high'
          : repo.calibrationFactor < 0.9 ? 'factor-low'
          : '';
        const factorText = !isActive
          ? 'Pending (' + (repo.observationsCount || 0) + '/10)'
          : repo.calibrationFactor.toFixed(2) + 'x';

        tr.innerHTML =
          '<td>' + repo.repoFullName + '</td>' +
          '<td>' + (repo.totalDeployments || 0) + '</td>' +
          '<td>' + successRate + '</td>' +
          '<td class="' + factorClass + '">' + factorText + '</td>';

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      container.innerHTML = '';
      container.appendChild(table);
    }

    async function loadCalibrationDetail(repoFullName) {
      try {
        const encoded = repoFullName.replace('/', '/');
        const response = await fetch(\`\${apiBase}/calibration/\${encoded}\`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('Not found');
        const repo = await response.json();
        alert(
          'Repo: ' + repo.repoFullName +
          '\\nFactor: ' + (repo.calibrationFactor || 1.0).toFixed(2) +
          '\\nFalse positives: ' + (repo.falsePositiveCount || 0) +
          '\\nFalse negatives: ' + (repo.falseNegativeCount || 0)
        );
      } catch (error) {
        alert('Failed to load calibration detail: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    }
  </script>
</body>
</html>`;
}
