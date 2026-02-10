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
  </div>

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
  </script>
</body>
</html>`;
}
