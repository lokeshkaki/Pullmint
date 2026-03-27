function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

const apiBase = '/dashboard';
const PAGE_SIZE = 20;
let currentOffset = 0;
let lastFetchedCount = 0;
let pollingInterval = null;
let eventSource = null;
let currentView = 'executions-view';
let trendChartInstance = null;
let costTrendChartInstance = null;
let analyticsTrendChartInstance = null;
let analyticsDonutChartInstance = null;
let analyticsSortKey = null;
let analyticsSortDir = 1; // 1 = asc, -1 = desc
let analyticsAuthorsData = [];
let analyticsReposData = [];

function getAuthHeaders() {
  const token = window.localStorage?.getItem('dashboardAuthToken');
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function getFilterParams() {
  const params = new URLSearchParams();

  const search = document.getElementById('searchInput')?.value?.trim();
  const repo = document.getElementById('repoFilter')?.value?.trim();
  const status = document.getElementById('statusFilter')?.value;
  const author = document.getElementById('authorFilter')?.value?.trim();
  const dateFrom = document.getElementById('dateFrom')?.value;
  const dateTo = document.getElementById('dateTo')?.value;
  const riskMin = document.getElementById('riskMin')?.value;
  const riskMax = document.getElementById('riskMax')?.value;
  const findingType = document.getElementById('findingTypeFilter')?.value;

  if (search) params.set('search', search);
  if (repo) params.set('repo', repo);
  if (status) params.set('status', status);
  if (author) params.set('author', author);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (riskMin) params.set('riskMin', riskMin);
  if (riskMax) params.set('riskMax', riskMax);
  if (findingType) params.set('findingType', findingType);

  return params;
}

async function loadExecutions(append = false) {
  try {
    if (!append) {
      currentOffset = 0;
    }

    const params = getFilterParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(currentOffset));

    const response = await fetch(`${apiBase}/executions?${params.toString()}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch executions');

    const data = await response.json();
    lastFetchedCount = Array.isArray(data.executions) ? data.executions.length : 0;

    if (!append) {
      updateStats(data.executions);
    }

    renderExecutions(data.executions, append);
    const repo = document.getElementById('repoFilter')?.value?.trim();
    if (repo) {
      void loadTrendChart(repo);
    } else {
      hideTrendChart();
    }

    const loadMoreBtn = document.querySelector('.load-more');
    const hasMore = lastFetchedCount === PAGE_SIZE;
    if (hasMore && !loadMoreBtn) {
      const btn = document.createElement('div');
      btn.className = 'load-more';
      const button = document.createElement('button');
      button.textContent = 'Load More';
      button.onclick = () => {
        currentOffset += PAGE_SIZE;
        void loadExecutions(true);
      };
      btn.appendChild(button);
      document.getElementById('executionList').appendChild(btn);
    } else if (!hasMore && loadMoreBtn) {
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

  executions.forEach((exec) => {
    const item = document.createElement('div');
    item.className = 'execution-item';
    item.setAttribute('data-execution-id', exec.executionId);
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
  const criticalAndHigh = findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high'
  );
  if (criticalAndHigh.length === 0) return '';

  const findingsContainer = document.createElement('div');
  findingsContainer.className = 'findings';

  const title = document.createElement('strong');
  title.textContent = 'Key Findings:';
  findingsContainer.appendChild(title);

  criticalAndHigh.slice(0, 3).forEach((finding) => {
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
    more.className = 'findings-more';
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
  environmentText.textContent = 'Environment: ' + (exec.deploymentEnvironment || 'staging');
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
    const scoredExecutions = executions.filter((e) => e.riskScore !== undefined);
    const scoredCount = scoredExecutions.length;

    if (scoredCount > 0) {
      const avgRisk = scoredExecutions.reduce((sum, e) => sum + e.riskScore, 0) / scoredCount;
      document.getElementById('avgRisk').textContent = avgRisk.toFixed(1);
    } else {
      document.getElementById('avgRisk').textContent = '-';
    }

    const deployed = executions.filter((e) => e.deploymentStatus === 'deployed').length;
    document.getElementById('deployedCount').textContent = deployed;

    const completed = executions.filter(
      (e) => e.status === 'completed' || e.status === 'deployed'
    ).length;
    const successRate = ((completed / total) * 100).toFixed(1);
    document.getElementById('successRate').textContent = successRate + '%';
  }
}

async function loadTrendChart(repoFullName) {
  const container = document.getElementById('trendChartContainer');
  if (!repoFullName) {
    hideTrendChart();
    return;
  }

  try {
    const response = await fetch(`${apiBase}/stats/${repoFullName}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      hideTrendChart();
      return;
    }

    const data = await response.json();
    const scores = data?.trends?.riskScores ?? [];

    if (scores.length < 2) {
      hideTrendChart();
      return;
    }

    container.style.display = 'block';

    if (trendChartInstance) {
      trendChartInstance.destroy();
      trendChartInstance = null;
    }

    const chartFactory = window.Chart;
    if (!chartFactory) {
      hideTrendChart();
      return;
    }

    const canvas = document.getElementById('trendChart');
    trendChartInstance = new chartFactory(canvas, {
      type: 'line',
      data: {
        labels: scores.map((item) => `PR #${item.prNumber}`),
        datasets: [
          {
            label: 'Risk Score',
            data: scores.map((item) => item.riskScore),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 6,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => items[0]?.label || '',
              label: (item) => `Risk: ${item.raw}/100`,
            },
          },
        },
        scales: {
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: 'Risk Score', color: '#666' },
            grid: { color: 'rgba(0, 0, 0, 0.08)' },
            ticks: { color: '#666' },
          },
          x: {
            grid: { display: false },
            ticks: { color: '#666', maxRotation: 45 },
          },
        },
      },
    });
  } catch (error) {
    console.warn('Failed to load trend chart:', error);
    hideTrendChart();
  }
}

function hideTrendChart() {
  const container = document.getElementById('trendChartContainer');
  if (container) {
    container.style.display = 'none';
  }
  if (trendChartInstance) {
    trendChartInstance.destroy();
    trendChartInstance = null;
  }
}

function formatTokens(count) {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M';
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
  return String(count);
}

async function loadCostData() {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dateFrom = monthStart.toISOString().split('T')[0];
    const dateTo = now.toISOString().split('T')[0];

    const [costsResp, budgetResp] = await Promise.all([
      fetch(`${apiBase}/analytics/costs?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
        headers: getAuthHeaders(),
      }),
      fetch(`${apiBase}/analytics/costs/budget-status`, {
        headers: getAuthHeaders(),
      }),
    ]);

    if (!costsResp.ok || !budgetResp.ok) {
      throw new Error('Failed to fetch cost data');
    }

    const costs = await costsResp.json();
    const budget = await budgetResp.json();

    renderCostSummary(costs, budget);
    renderCostTrendChart(costs.dailyTrend);
    renderCostByRepoTable(costs.byRepo, budget.repos);
    renderCostByAgentTable(costs.byAgent);
    renderCostByModelTable(costs.byModel);
    renderBudgetStatus(budget.repos, budget.resetDate);
  } catch (error) {
    console.error('Error loading cost data:', error);
  }
}

function renderCostSummary(costs, budget) {
  const totalPrCount = costs.byRepo.reduce((sum, row) => sum + row.prCount, 0);
  const avgCostPerPr = totalPrCount > 0 ? costs.totalCostUsd / totalPrCount : 0;
  const projectedUsd = budget.repos.reduce((sum, row) => sum + (row.projectedUsd ?? 0), 0);

  const setValue = (id, text) => {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = text;
    }
  };

  setValue('costTotalMtd', '$' + costs.totalCostUsd.toFixed(2));
  setValue('costTotalTokens', formatTokens(costs.totalInputTokens + costs.totalOutputTokens));
  setValue('costAvgPerPr', totalPrCount > 0 ? '$' + avgCostPerPr.toFixed(4) : '-');
  setValue('costProjected', '$' + projectedUsd.toFixed(2));
}

function renderCostTrendChart(dailyTrend) {
  const canvas = document.getElementById('costTrendChart');
  if (!canvas) return;

  if (costTrendChartInstance) {
    costTrendChartInstance.destroy();
    costTrendChartInstance = null;
  }

  if (!dailyTrend || dailyTrend.length === 0) return;

  const chartFactory = window.Chart;
  if (!chartFactory) return;

  costTrendChartInstance = new chartFactory(canvas, {
    type: 'line',
    data: {
      labels: dailyTrend.map((d) => d.date),
      datasets: [
        {
          label: 'Daily Spend (USD)',
          data: dailyTrend.map((d) => d.costUsd),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (value) => '$' + Number(value).toFixed(2) },
        },
      },
    },
  });
}

function renderCostByRepoTable(byRepo, budgetRepos) {
  const tbody = document.querySelector('#costByRepoTable tbody');
  if (!tbody) return;

  const budgetMap = Object.fromEntries((budgetRepos ?? []).map((row) => [row.repoFullName, row]));

  tbody.innerHTML = byRepo
    .map((row) => {
      const budgetInfo = budgetMap[row.repoFullName];
      let budgetCell = '-';
      if (budgetInfo?.budgetUsd) {
        const pct = Math.min(100, Math.round((budgetInfo.usedUsd / budgetInfo.budgetUsd) * 100));
        const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';
        budgetCell =
          `<div style="font-size:0.85em">${pct}% of $${budgetInfo.budgetUsd.toFixed(2)}</div>` +
          `<div style="height:6px;background:#e5e7eb;border-radius:3px;margin-top:2px">` +
          `<div style="width:${pct}%;height:6px;background:${color};border-radius:3px"></div>` +
          `</div>`;
      }

      return `<tr>
      <td>${escapeHtml(row.repoFullName)}</td>
      <td>$${row.costUsd.toFixed(4)}</td>
      <td>${row.prCount}</td>
      <td>${budgetCell}</td>
    </tr>`;
    })
    .join('');
}

function renderCostByAgentTable(byAgent) {
  const tbody = document.querySelector('#costByAgentTable tbody');
  if (!tbody) return;

  tbody.innerHTML = byAgent
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row.agentType)}</td>
      <td>$${row.costUsd.toFixed(4)}</td>
      <td>${row.callCount}</td>
    </tr>`
    )
    .join('');
}

function renderCostByModelTable(byModel) {
  const tbody = document.querySelector('#costByModelTable tbody');
  if (!tbody) return;

  tbody.innerHTML = byModel
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row.model)}</td>
      <td>$${row.costUsd.toFixed(4)}</td>
      <td>${formatTokens(row.tokenCount)}</td>
    </tr>`
    )
    .join('');
}

function renderBudgetStatus(repos, resetDate) {
  const container = document.getElementById('budgetStatusList');
  if (!container) return;

  const reposWithBudget = (repos ?? []).filter((row) => row.budgetUsd !== null);
  if (reposWithBudget.length === 0) {
    container.innerHTML =
      '<p style="color:#6b7280">No repositories have a monthly budget configured.</p>';
    return;
  }

  container.innerHTML = reposWithBudget
    .map((row) => {
      const pct = Math.min(100, Math.round((row.usedUsd / row.budgetUsd) * 100));
      const color = row.budgetExceeded ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';

      return `<div class="budget-status-row">
      <strong>${escapeHtml(row.repoFullName)}</strong>
      <span style="color:${color}">${pct}% used - $${row.usedUsd.toFixed(2)} / $${row.budgetUsd.toFixed(2)}</span>
      ${row.budgetExceeded ? '<span class="badge failed">EXCEEDED</span>' : ''}
      <div style="height:8px;background:#e5e7eb;border-radius:4px;margin:4px 0">
        <div style="width:${pct}%;height:8px;background:${color};border-radius:4px"></div>
      </div>
      <small style="color:#6b7280">Resets ${escapeHtml(resetDate)} | Projected: $${row.projectedUsd.toFixed(2)}/mo</small>
    </div>`;
    })
    .join('');
}

function applyFilters() {
  currentOffset = 0;
  void loadExecutions();
}

function clearFilters() {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';

  document.getElementById('repoFilter').value = '';
  document.getElementById('statusFilter').value = '';

  const authorFilter = document.getElementById('authorFilter');
  if (authorFilter) authorFilter.value = '';
  const dateFrom = document.getElementById('dateFrom');
  if (dateFrom) dateFrom.value = '';
  const dateTo = document.getElementById('dateTo');
  if (dateTo) dateTo.value = '';
  const riskMin = document.getElementById('riskMin');
  if (riskMin) riskMin.value = '';
  const riskMax = document.getElementById('riskMax');
  if (riskMax) riskMax.value = '';
  const findingTypeFilter = document.getElementById('findingTypeFilter');
  if (findingTypeFilter) findingTypeFilter.value = '';

  currentOffset = 0;
  void loadExecutions();
  hideTrendChart();
}

async function viewExecution(executionId) {
  try {
    const response = await fetch(`${apiBase}/executions/${executionId}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch execution details');

    const exec = await response.json();
    console.log('Execution details:', exec);

    // Could open a modal or navigate to detail page
    alert(
      `Execution ID: ${exec.executionId}\\nStatus: ${exec.status}\\nRisk Score: ${exec.riskScore || 'N/A'}\\nFindings: ${exec.findings?.length || 0}`
    );
  } catch (error) {
    console.error('Error fetching execution:', error);
    alert('Error loading execution details');
  }
}

// Auto-refresh every 10 seconds
function startPolling() {
  pollingInterval = setInterval(() => {
    loadExecutions();
  }, 60000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function connectSSE() {
  const token = window.localStorage?.getItem('dashboardAuthToken');
  if (!token) return;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const url = `${apiBase}/events?token=${encodeURIComponent(token)}`;
  eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleExecutionUpdate(data);
    } catch (err) {
      console.error('Failed to parse SSE event:', err);
    }
  };

  eventSource.addEventListener('open', () => {
    loadExecutions();
  });

  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      console.error('SSE connection closed permanently');
    }
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleExecutionUpdate(data) {
  const row = document.querySelector(`[data-execution-id="${data.executionId}"]`);
  if (row) {
    updateExecutionRow(row, data);
  } else if (data.status === 'pending' || data.status === 'analyzing') {
    loadExecutions();
  }

  if (currentView === 'board-view') {
    loadBoard();
  }

  if (currentView === 'detail-view' && currentExecutionId === data.executionId) {
    showExecutionDetail(data.executionId);
  }
}

function updateExecutionRow(row, data) {
  if (data.status) {
    const statusBadge = row.querySelector('.badge');
    if (statusBadge) {
      statusBadge.textContent = data.status;
      statusBadge.className = 'badge ' + data.status;
    }
  }

  if (data.riskScore !== null && data.riskScore !== undefined) {
    const riskEl = row.querySelector('.risk-score');
    if (riskEl) {
      riskEl.textContent = 'Risk: ' + data.riskScore;
      riskEl.className = 'risk-score ' + getRiskClass(data.riskScore);
    }
  }
}

function initializeDashboard() {
  document.querySelectorAll('.nav-tab[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view, btn));
  });

  document.getElementById('applyFiltersBtn')?.addEventListener('click', applyFilters);
  document.getElementById('clearFiltersBtn')?.addEventListener('click', clearFilters);
  document
    .getElementById('refreshExecutionsBtn')
    ?.addEventListener('click', () => loadExecutions());
  document.getElementById('boardRefreshBtn')?.addEventListener('click', loadBoard);
  document
    .getElementById('backToBoardBtn')
    ?.addEventListener('click', () => showView('board-view', null));
  document.getElementById('overrideBtn')?.addEventListener('click', openJustificationModal);
  document.getElementById('copyLinkBtn')?.addEventListener('click', copyDeepLink);
  document.getElementById('calibrationRefreshBtn')?.addEventListener('click', loadCalibration);
  document.getElementById('modalCancelBtn')?.addEventListener('click', closeJustificationModal);
  document.getElementById('modalSubmitBtn')?.addEventListener('click', submitOverride);

  document.getElementById('applyAnalyticsBtn')?.addEventListener('click', () => {
    void loadAnalytics();
  });

  document.getElementById('clearAnalyticsBtn')?.addEventListener('click', () => {
    document.getElementById('analyticsDateFrom').value = '';
    document.getElementById('analyticsDateTo').value = '';
    void loadAnalytics();
  });

  document.getElementById('trendsInterval')?.addEventListener('change', () => {
    void loadAnalyticsTrend();
  });

  setupAnalyticsTableSort();

  loadExecutions();
  startPolling();
  connectSSE();
}

// Stop polling when page is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      connectSSE();
    }
  }
});

window.addEventListener('beforeunload', () => {
  disconnectSSE();
});

initializeDashboard();

// ===========================
// View navigation
// ===========================
let activeViewBtn = document.querySelector('.nav-tab.active');

function showView(viewId, btn) {
  currentView = viewId;
  [
    'executions-view',
    'board-view',
    'detail-view',
    'calibration-view',
    'analytics-view',
    'costs-view',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const view = document.getElementById(viewId);
  if (view) view.classList.remove('hidden');

  if (activeViewBtn) activeViewBtn.classList.remove('active');
  if (btn) {
    btn.classList.add('active');
    activeViewBtn = btn;
  }

  if (viewId === 'board-view') loadBoard();
  if (viewId === 'calibration-view') loadCalibration();
  if (viewId === 'analytics-view') void loadAnalytics();
  if (viewId === 'costs-view') void loadCostData();
}

// ===========================
// Risk Board
// ===========================
let boardPollingInterval = null;

async function loadBoard() {
  const container = document.getElementById('boardContainer');
  container.innerHTML = '<div class="loading">Loading board...</div>';
  try {
    const response = await fetch(`${apiBase}/board`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch board');
    const data = await response.json();
    renderBoard(data.board);
    updateBoardStats(data.board);
  } catch (error) {
    container.innerHTML =
      '<div class="error">Failed to load board: ' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') +
      '</div>';
  }
}

function updateBoardStats(board) {
  const statsEl = document.getElementById('boardStats');
  const active = (board.deploying || []).length + (board.monitoring || []).length;
  const held = (board.completed || []).length;
  const rolled = (board['rolled-back'] || []).length;
  statsEl.innerHTML =
    '<span><strong>' +
    active +
    '</strong> active</span>' +
    '<span><strong>' +
    held +
    '</strong> held</span>' +
    '<span><strong>' +
    rolled +
    '</strong> rollbacks (24h)</span>';
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

  BOARD_COLUMNS.forEach((col) => {
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
      empty.className = 'board-empty';
      empty.textContent = 'No deployments';
      cardContainer.appendChild(empty);
    }

    cards.forEach((card) => {
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
        riskSpan.className = 'risk-score board-card-risk ' + riskClass;
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
  document.getElementById('checkpointDetail').classList.add('hidden');

  try {
    const response = await fetch(`${apiBase}/executions/${executionId}/checkpoints`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch checkpoint data');
    const data = await response.json();
    renderTimeline(data.checkpoints);
    renderRepoContext(data.repoContext);
    renderSignalCoverage(data.signalsReceived);
  } catch (error) {
    document.getElementById('checkpointTimeline').innerHTML =
      '<div class="error">Failed to load: ' +
      (error instanceof Error ? error.message : 'Unknown error') +
      '</div>';
  }
}

const CHECKPOINT_TYPES = ['analysis', 'pre-deploy', 'post-deploy-5', 'post-deploy-30'];
const CHECKPOINT_LABELS = {
  analysis: 'Analysis',
  'pre-deploy': 'Pre-Deploy',
  'post-deploy-5': 'T+5min',
  'post-deploy-30': 'T+30min',
};

function renderTimeline(checkpoints) {
  const container = document.getElementById('checkpointTimeline');
  container.innerHTML = '';

  const completedTypes = new Set(checkpoints.map((c) => c.type));

  CHECKPOINT_TYPES.forEach((type, i) => {
    if (i > 0) {
      const connector = document.createElement('div');
      connector.className = 'checkpoint-connector';
      container.appendChild(connector);
    }

    const cp = checkpoints.find((c) => c.type === type);
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
    dot.textContent = cp
      ? cp.decision === 'approved'
        ? '✓'
        : cp.decision === 'rollback'
          ? '✗'
          : '!'
      : (i + 1).toString();
    node.appendChild(dot);

    const label = document.createElement('div');
    label.className = 'checkpoint-node-label';
    label.textContent = CHECKPOINT_LABELS[type] || type;
    node.appendChild(label);

    if (cp) {
      const score = document.createElement('div');
      score.className = 'checkpoint-score';
      score.textContent = 'Score: ' + cp.score;
      node.appendChild(score);
    }

    container.appendChild(node);
  });
}

function showCheckpointDetail(cp) {
  const detailEl = document.getElementById('checkpointDetail');
  if (!cp) {
    detailEl.classList.add('hidden');
    return;
  }
  detailEl.classList.remove('hidden');
  detailEl.innerHTML =
    '<strong>' +
    escapeHtml(CHECKPOINT_LABELS[cp.type] || cp.type) +
    '</strong>' +
    '<p class="checkpoint-detail-primary-text">' +
    escapeHtml(cp.reason || 'No reason provided.') +
    '</p>' +
    '<p class="checkpoint-detail-meta">Score: ' +
    escapeHtml(cp.score) +
    ' &nbsp;|&nbsp; Confidence: ' +
    (cp.confidence != null ? Math.round(cp.confidence * 100) + '%' : 'N/A') +
    ' &nbsp;|&nbsp; Decision: <strong>' +
    escapeHtml(cp.decision) +
    '</strong></p>';
}

function renderRepoContext(repoContext) {
  const panel = document.getElementById('repoContextPanel');
  if (!repoContext) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML =
    '<div class="repo-context-card">' +
    '<h3 class="repo-context-heading">Repo Context</h3>' +
    '<div class="repo-context-body">' +
    '<div>Blast radius multiplier: <strong>' +
    (repoContext.blastRadiusMultiplier || 1.0).toFixed(2) +
    'x</strong></div>' +
    '<div>Downstream dependents: <strong>' +
    (repoContext.downstreamDependentCount || 0) +
    '</strong></div>' +
    '<div>30-day rollback rate: <strong>' +
    (repoContext.repoRollbackRate30d != null
      ? (repoContext.repoRollbackRate30d * 100).toFixed(1) + '%'
      : 'N/A') +
    '</strong></div>' +
    '</div></div>';
}

function renderSignalCoverage(signalsReceived) {
  const panel = document.getElementById('signalCoverage');
  const list = document.getElementById('signalList');
  if (!signalsReceived || Object.keys(signalsReceived).length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  Object.entries(signalsReceived).forEach(([key, sig]) => {
    const row = document.createElement('div');
    row.className = 'signal-row';
    const dot = document.createElement('div');
    dot.className = 'signal-dot received';
    const label = document.createElement('span');
    label.textContent =
      key + ' — ' + sig.source + ' (' + new Date(sig.receivedAt).toLocaleString() + ')';
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
    const response = await fetch(`${apiBase}/executions/${currentExecutionId}/re-evaluate`, {
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
    navigator.clipboard.writeText(
      window.location.origin + window.location.pathname + '?exec=' + currentExecutionId
    );
    alert('Link copied!');
  }
}

// ===========================
// Analytics
// ===========================

function getAnalyticsDateParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('analyticsDateFrom')?.value;
  const to = document.getElementById('analyticsDateTo')?.value;
  if (from) params.set('dateFrom', from);
  if (to) params.set('dateTo', to);
  return params;
}

async function loadAnalyticsSummary() {
  try {
    const params = getAnalyticsDateParams();
    const res = await fetch(`${apiBase}/analytics/summary?${params}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch analytics summary');
    const data = await res.json();

    document.getElementById('analyticsTotalPRs').textContent = data.totalPRsAnalyzed;
    document.getElementById('analyticsAvgRisk').textContent = data.avgRiskScore;
    const autoApprovedPct =
      data.totalPRsAnalyzed > 0
        ? Math.round((data.autoApproved / data.totalPRsAnalyzed) * 100) + '%'
        : '0%';
    document.getElementById('analyticsAutoApproved').textContent = autoApprovedPct;
    const rollbackRate =
      data.totalPRsAnalyzed > 0
        ? Math.round((data.rolledBack / data.totalPRsAnalyzed) * 100) + '%'
        : '0%';
    document.getElementById('analyticsRollbackRate').textContent = rollbackRate;

    renderFindingDonut(data.topFindingTypes);
  } catch (err) {
    console.error('Analytics summary error:', err);
  }
}

function renderFindingDonut(topFindingTypes) {
  const ctx = document.getElementById('analyticsDonutChart')?.getContext('2d');
  if (!ctx) return;

  const labels = topFindingTypes.map((f) => f.type);
  const counts = topFindingTypes.map((f) => f.count);
  const colors = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

  if (analyticsDonutChartInstance) {
    analyticsDonutChartInstance.destroy();
  }
  analyticsDonutChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors.slice(0, labels.length) }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'right' } },
    },
  });
}

async function loadAnalyticsTrend() {
  try {
    const params = getAnalyticsDateParams();
    const interval = document.getElementById('trendsInterval')?.value ?? 'day';
    params.set('interval', interval);

    const res = await fetch(`${apiBase}/analytics/trends?${params}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch analytics trends');
    const data = await res.json();

    const ctx = document.getElementById('analyticsTrendChart')?.getContext('2d');
    if (!ctx) return;

    const labels = data.buckets.map((b) => b.date);
    const riskData = data.buckets.map((b) => b.avgRisk);
    const prCountData = data.buckets.map((b) => b.prCount);

    if (analyticsTrendChartInstance) {
      analyticsTrendChartInstance.destroy();
    }
    analyticsTrendChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Risk Score',
            data: riskData,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.1)',
            yAxisID: 'yRisk',
            tension: 0.3,
            fill: true,
          },
          {
            label: 'PR Count',
            data: prCountData,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99,102,241,0.1)',
            yAxisID: 'yCount',
            tension: 0.3,
            type: 'bar',
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          yRisk: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Avg Risk' },
          },
          yCount: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'PR Count' },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  } catch (err) {
    console.error('Analytics trends error:', err);
  }
}

async function loadAnalyticsAuthors() {
  try {
    const params = getAnalyticsDateParams();
    const res = await fetch(`${apiBase}/analytics/authors?${params}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch analytics authors');
    const data = await res.json();
    analyticsAuthorsData = data.authors;
    renderAuthorsTable(analyticsAuthorsData);
  } catch (err) {
    console.error('Analytics authors error:', err);
  }
}

function renderAuthorsTable(authors) {
  const tbody = document.getElementById('analyticsAuthorsBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (authors.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No data for this date range.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  for (const a of authors) {
    const row = document.createElement('tr');
    const trendArrow = a.trend === 'improving' ? '↓' : a.trend === 'declining' ? '↑' : '→';
    const trendClass =
      a.trend === 'improving' ? 'risk-low' : a.trend === 'declining' ? 'risk-high' : '';
    row.innerHTML = `
      <td>${escapeHtml(a.login)}</td>
      <td>${a.prCount}</td>
      <td>${a.avgRiskScore}</td>
      <td>${(a.rollbackRate * 100).toFixed(1)}%</td>
      <td>${escapeHtml(a.topFindingType ?? '-')}</td>
      <td class="${trendClass}">${trendArrow} ${a.trend}</td>
    `;
    tbody.appendChild(row);
  }
}

async function loadAnalyticsRepos() {
  try {
    const params = getAnalyticsDateParams();
    const res = await fetch(`${apiBase}/analytics/repos?${params}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch analytics repos');
    const data = await res.json();
    analyticsReposData = data.repos;
    renderReposTable(analyticsReposData);
  } catch (err) {
    console.error('Analytics repos error:', err);
  }
}

function renderReposTable(repos) {
  const tbody = document.getElementById('analyticsReposBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (repos.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No data for this date range.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  for (const r of repos) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(r.repoFullName)}</td>
      <td>${r.prCount}</td>
      <td>${r.avgRiskScore}</td>
      <td>${(r.rollbackRate * 100).toFixed(1)}%</td>
      <td>${r.calibrationFactor !== null ? r.calibrationFactor.toFixed(2) : '-'}</td>
      <td>${(r.topFindingTypes ?? []).map((t) => escapeHtml(t)).join(', ') || '-'}</td>
    `;
    tbody.appendChild(row);
  }
}

function setupAnalyticsTableSort() {
  document.querySelectorAll('#analyticsAuthorsTable th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (analyticsSortKey === key) {
        analyticsSortDir *= -1;
      } else {
        analyticsSortKey = key;
        analyticsSortDir = 1;
      }
      const sorted = [...analyticsAuthorsData].sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        return av < bv ? -analyticsSortDir : av > bv ? analyticsSortDir : 0;
      });
      renderAuthorsTable(sorted);
    });
  });

  document.querySelectorAll('#analyticsReposTable th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (analyticsSortKey === key) {
        analyticsSortDir *= -1;
      } else {
        analyticsSortKey = key;
        analyticsSortDir = 1;
      }
      const sorted = [...analyticsReposData].sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        return av < bv ? -analyticsSortDir : av > bv ? analyticsSortDir : 0;
      });
      renderReposTable(sorted);
    });
  });
}

async function loadAnalytics() {
  await Promise.all([
    loadAnalyticsSummary(),
    loadAnalyticsTrend(),
    loadAnalyticsAuthors(),
    loadAnalyticsRepos(),
  ]);
}

// ===========================
// Calibration Panel
// ===========================
async function loadCalibration() {
  const container = document.getElementById('calibrationContainer');
  container.innerHTML = '<div class="loading">Loading calibration data...</div>';
  try {
    const response = await fetch(`${apiBase}/calibration`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch calibration data');
    const data = await response.json();
    renderCalibration(data.repos);
  } catch (error) {
    container.innerHTML =
      '<div class="error">Failed to load calibration: ' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') +
      '</div>';
  }
}

function renderCalibration(repos) {
  const container = document.getElementById('calibrationContainer');

  if (!repos || repos.length === 0) {
    container.innerHTML =
      '<div class="empty">No calibration data yet. Calibration begins after 10 deployments per repo.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'calibration-table';

  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr><th>Repo</th><th>Deployments</th><th>Success Rate</th><th>Calibration Factor</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  repos.forEach((repo) => {
    const tr = document.createElement('tr');
    tr.onclick = () => loadCalibrationDetail(repo.repoFullName);

    const isActive = (repo.observationsCount || 0) >= 10;
    const successRate =
      repo.totalDeployments > 0
        ? ((repo.successCount / repo.totalDeployments) * 100).toFixed(1) + '%'
        : 'N/A';
    const factorClass = !isActive
      ? 'factor-inactive'
      : repo.calibrationFactor > 1.1
        ? 'factor-high'
        : repo.calibrationFactor < 0.9
          ? 'factor-low'
          : '';
    const factorText = !isActive
      ? 'Pending (' + (repo.observationsCount || 0) + '/10)'
      : repo.calibrationFactor.toFixed(2) + 'x';

    tr.innerHTML =
      '<td>' +
      escapeHtml(repo.repoFullName) +
      '</td>' +
      '<td>' +
      escapeHtml(repo.totalDeployments || 0) +
      '</td>' +
      '<td>' +
      escapeHtml(successRate) +
      '</td>' +
      '<td class="' +
      escapeHtml(factorClass) +
      '">' +
      escapeHtml(factorText) +
      '</td>';

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

async function loadCalibrationDetail(repoFullName) {
  try {
    const encoded = repoFullName.replace('/', '/');
    const response = await fetch(`${apiBase}/calibration/${encoded}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Not found');
    const repo = await response.json();
    alert(
      'Repo: ' +
        repo.repoFullName +
        '\\nFactor: ' +
        (repo.calibrationFactor || 1.0).toFixed(2) +
        '\\nFalse positives: ' +
        (repo.falsePositiveCount || 0) +
        '\\nFalse negatives: ' +
        (repo.falseNegativeCount || 0)
    );
  } catch (error) {
    alert(
      'Failed to load calibration detail: ' +
        (error instanceof Error ? error.message : 'Unknown error')
    );
  }
}
