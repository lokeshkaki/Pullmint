import { getArchitecturePrompt } from '../src/prompts/architecture';
import { getSecurityPrompt } from '../src/prompts/security';
import { getPerformancePrompt } from '../src/prompts/performance';
import { getMaintainabilityPrompt } from '../src/prompts/maintainability';

describe('agent prompts', () => {
  it('returns architecture prompt with architecture findings type', () => {
    const prompt = getArchitecturePrompt();
    expect(prompt).toContain('"type": "architecture"');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('returns security prompt with security findings type', () => {
    const prompt = getSecurityPrompt();
    expect(prompt).toContain('"type": "security"');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('returns performance prompt with performance findings type', () => {
    const prompt = getPerformancePrompt();
    expect(prompt).toContain('"type": "performance"');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('returns maintainability prompt with style findings type', () => {
    const prompt = getMaintainabilityPrompt();
    expect(prompt).toContain('"type": "style"');
    expect(prompt.length).toBeGreaterThan(200);
  });
});
