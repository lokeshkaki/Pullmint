import { runTool, toolDefinitions } from '../src/tools';

describe('MCP tool definitions', () => {
  it('exports exactly four reads and two explicit actions', () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      'pullmint_list_pr_analyses',
      'pullmint_get_analysis',
      'pullmint_get_analysis_evidence',
      'pullmint_get_repo_calibration',
      'pullmint_record_re_evaluation',
      'pullmint_trigger_analysis',
    ]);
  });

  it('does not represent re-evaluation as a rerun', () => {
    const description = toolDefinitions.find(
      (tool) => tool.name === 'pullmint_record_re_evaluation'
    )!.description;
    expect(description).toContain('does not run analysis');
  });

  it('warns that trigger analysis incurs cost and downstream effects', () => {
    const description = toolDefinitions.find(
      (tool) => tool.name === 'pullmint_trigger_analysis'
    )!.description;
    expect(description).toContain('provider cost');
    expect(description).toContain('GitHub review');
    expect(description).toContain('deployment gating');
  });

  it.each(toolDefinitions.map((tool) => tool.name))('rejects missing input for %s', async (name) => {
    await expect(runTool({} as never, name, {})).rejects.toBeDefined();
  });

  it('delegates manual trigger only when its explicit tool is called', async () => {
    const client = {
      listPrAnalyses: jest.fn().mockResolvedValue({ executions: [], count: 0 }),
      triggerAnalysis: jest
        .fn()
        .mockResolvedValue({ executionId: 'manual-1', costIncurred: true }),
    };

    await runTool(client as never, 'pullmint_list_pr_analyses', {
      owner: 'org',
      repo: 'repo',
      prNumber: 42,
      limit: 10,
    });
    expect(client.triggerAnalysis).not.toHaveBeenCalled();

    await runTool(client as never, 'pullmint_trigger_analysis', {
      owner: 'org',
      repo: 'repo',
      prNumber: 42,
      reason: 'Validate fix',
    });
    expect(client.triggerAnalysis).toHaveBeenCalledTimes(1);
  });
});
