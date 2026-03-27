function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

const apiBase = '/dashboard';
const PAGE_SIZE = 20;
const TERMINAL_FOR_RERUN = ['completed', 'failed', 'confirmed', 'rolled-back'];
let currentOffset = 0;
let lastFetchedCount = 0;
let pollingInterval = null;
let eventSource = null;
let currentView = 'executions-view';
let trendChartInstance = null;

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

    if (TERMINAL_FOR_RERUN.includes(exec.status)) {
      const rerunIconBtn = document.createElement('button');
      rerunIconBtn.className = 'rerun-icon-btn';
      rerunIconBtn.title = 'Re-run analysis';
      rerunIconBtn.textContent = 'Re-run';
      rerunIconBtn.onclick = (e) => {
        e.stopPropagation();
        void triggerRerunFor(exec.executionId);
      };
      item.appendChild(rerunIconBtn);
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
  document.getElementById('rerunBtn')?.addEventListener('click', triggerRerun);
  document.getElementById('copyLinkBtn')?.addEventListener('click', copyDeepLink);
  document.getElementById('calibrationRefreshBtn')?.addEventListener('click', loadCalibration);
  document.getElementById('modalCancelBtn')?.addEventListener('click', closeJustificationModal);
  document.getElementById('modalSubmitBtn')?.addEventListener('click', submitOverride);

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
  ['executions-view', 'board-view', 'detail-view', 'calibration-view'].forEach((id) => {
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
  document.getElementById('rerunBtn').style.display = 'none';
  document.getElementById('rerunHistory').classList.add('hidden');

  try {
    const [checkpointRes, execRes] = await Promise.all([
      fetch(`${apiBase}/executions/${executionId}/checkpoints`, {
        headers: getAuthHeaders(),
      }),
      fetch(`${apiBase}/executions/${executionId}`, {
        headers: getAuthHeaders(),
      }),
    ]);

    if (!checkpointRes.ok) throw new Error('Failed to fetch checkpoint data');

    const data = await checkpointRes.json();
    renderTimeline(data.checkpoints);
    renderRepoContext(data.repoContext);
    renderSignalCoverage(data.signalsReceived);

    if (execRes.ok) {
      const exec = await execRes.json();
      if (TERMINAL_FOR_RERUN.includes(exec.status)) {
        document.getElementById('rerunBtn').style.display = '';
      }
      void loadRerunHistory(executionId);
    }
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

async function loadRerunHistory(executionId) {
  try {
    const response = await fetch(`${apiBase}/executions/${executionId}/rerun-history`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) return;

    const data = await response.json();
    if (!data.chain || data.chain.length <= 1) return;

    renderRerunHistory(data.chain);
  } catch {
    // Non-critical UI enrichment
  }
}

function renderRerunHistory(chain) {
  const section = document.getElementById('rerunHistory');
  const list = document.getElementById('rerunHistoryList');
  list.innerHTML = '';

  chain.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'rerun-history-row' + (entry.isCurrentExecution ? ' current' : '');

    const label = document.createElement('span');
    label.className = 'rerun-history-label';
    label.textContent = idx === 0 ? 'Original' : 'Re-run #' + idx;

    const link = document.createElement('button');
    link.className = 'rerun-history-link';
    link.textContent = entry.executionId.substring(0, 20) + '...';
    link.onclick = () => showExecutionDetail(entry.executionId);

    const status = document.createElement('span');
    status.className = 'badge ' + entry.status;
    status.textContent = entry.status;

    const risk = document.createElement('span');
    risk.className = 'rerun-history-risk';
    if (entry.riskScore != null) {
      risk.textContent = 'Risk: ' + entry.riskScore;
      if (entry.riskScoreDelta != null) {
        const sign = entry.riskScoreDelta > 0 ? '+' : '';
        risk.textContent += ' (' + sign + entry.riskScoreDelta + ')';
      }
    } else {
      risk.textContent = '-';
    }

    row.appendChild(label);
    row.appendChild(link);
    row.appendChild(status);
    row.appendChild(risk);
    list.appendChild(row);
  });

  section.classList.remove('hidden');
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

async function triggerRerun() {
  if (!currentExecutionId) return;

  const btn = document.getElementById('rerunBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const response = await fetch(`${apiBase}/executions/${currentExecutionId}/rerun`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    if (response.status === 409) {
      alert(
        'This execution is still in progress — re-run is only available after analysis completes.'
      );
      btn.disabled = false;
      btn.textContent = 'Re-run Analysis';
      return;
    }

    if (response.status === 429) {
      alert('Rate limit: wait 1 minute before re-running again.');
      btn.disabled = false;
      btn.textContent = 'Re-run Analysis';
      return;
    }

    if (!response.ok) {
      alert('Re-run failed. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Re-run Analysis';
      return;
    }

    const data = await response.json();
    btn.textContent = 'Re-run Analysis';
    btn.disabled = false;
    showExecutionDetail(data.executionId);
  } catch (error) {
    alert('Re-run failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    btn.disabled = false;
    btn.textContent = 'Re-run Analysis';
  }
}

async function triggerRerunFor(executionId) {
  try {
    const response = await fetch(`${apiBase}/executions/${executionId}/rerun`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    if (response.status === 409) {
      alert(
        'This execution is still in progress — re-run is only available after analysis completes.'
      );
      return;
    }

    if (response.status === 429) {
      alert('Rate limit: wait 1 minute before re-running again.');
      return;
    }

    if (!response.ok) {
      alert('Re-run failed. Please try again.');
      return;
    }

    const data = await response.json();
    showExecutionDetail(data.executionId);
  } catch (error) {
    alert('Re-run failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
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
