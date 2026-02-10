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

    body {
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
      </div>
    </div>
  </div>

  <script>
    const apiBase = window.location.origin + "/dashboard";
    let currentFilters = {};
    let nextToken = null;
    let pollingInterval = null;

    async function loadExecutions(append = false) {
      try {
        const params = new URLSearchParams(currentFilters);
        if (append && nextToken) {
          params.set('nextToken', nextToken);
        }

        const response = await fetch(\`\${apiBase}/executions?\${params}\`);
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
          btn.innerHTML = '<button onclick="loadExecutions(true)">Load More</button>';
          document.getElementById('executionList').appendChild(btn);
        } else if (!nextToken && loadMoreBtn) {
          loadMoreBtn.remove();
        }

      } catch (error) {
        console.error('Error loading executions:', error);
        document.getElementById('executionList').innerHTML = 
          \`<div class="error">Error loading executions: \${error.message}</div>\`;
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
        container.innerHTML = '<div class="empty">No executions found</div>';
        return;
      }

      executions.forEach(exec => {
        const item = document.createElement('div');
        item.className = 'execution-item';
        item.onclick = () => viewExecution(exec.executionId);
        
        const timestamp = exec.timestamp ? new Date(exec.timestamp).toLocaleString() : 'Unknown';
        const riskClass = getRiskClass(exec.riskScore);
        
        item.innerHTML = \`
          <div class="execution-header">
            <div class="execution-title">\${exec.repoFullName} #\${exec.prNumber}</div>
            <span class="badge \${exec.status}">\${exec.status}</span>
          </div>
          <div class="execution-meta">
            <span>📅 \${timestamp}</span>
            <span>🔗 \${exec.headSha.substring(0, 7)}</span>
            \${exec.riskScore !== undefined ? \`<span class="risk-score \${riskClass}">Risk: \${exec.riskScore}</span>\` : ''}
          </div>
          \${exec.findings && exec.findings.length > 0 ? renderFindings(exec.findings) : ''}
          \${exec.deploymentStatus ? renderDeployment(exec) : ''}
        \`;
        
        container.appendChild(item);
      });
    }

    function renderFindings(findings) {
      const criticalAndHigh = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
      if (criticalAndHigh.length === 0) return '';
      
      return \`
        <div class="findings">
          <strong>Key Findings:</strong>
          \${criticalAndHigh.slice(0, 3).map(f => \`
            <div class="finding-item">
              <span class="finding-severity \${f.severity}">\${f.severity}</span>
              \${f.title}
            </div>
          \`).join('')}
          \${findings.length > 3 ? \`<div style="font-size: 12px; color: #666; margin-top: 5px;">+\${findings.length - 3} more findings</div>\` : ''}
        </div>
      \`;
    }

    function renderDeployment(exec) {
      return \`
        <div class="deployment-timeline">
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <span>Environment: \${exec.deploymentEnvironment || 'staging'}</span>
          </div>
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <span>Status: \${exec.deploymentStatus}</span>
          </div>
          \${exec.deploymentCompletedAt ? \`
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <span>Completed: \${new Date(exec.deploymentCompletedAt).toLocaleString()}</span>
            </div>
          \` : ''}
        </div>
      \`;
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
        const avgRisk = executions
          .filter(e => e.riskScore !== undefined)
          .reduce((sum, e) => sum + e.riskScore, 0) / total;
        document.getElementById('avgRisk').textContent = avgRisk.toFixed(1);

        const deployed = executions.filter(e => e.deploymentStatus === 'deployed').length;
        document.getElementById('deployedCount').textContent = deployed;

        const completed = executions.filter(e => e.status === 'completed' || e.status === 'deployed').length;
        const successRate = (completed / total * 100).toFixed(1);
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
        const response = await fetch(\`\${apiBase}/executions/\${executionId}\`);
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
