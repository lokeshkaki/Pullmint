import { registerSuite } from '../src/harness';

describe('harness', () => {
  describe('registerSuite', () => {
    it('registers a suite without throwing', () => {
      expect(() => {
        registerSuite({
          name: 'test-suite',
          tasks: [
            {
              name: 'no-op task',
              fn: () => { /* intentionally empty */ },
            },
          ],
        });
      }).not.toThrow();
    });

    it('accepts async task functions', () => {
      expect(() => {
        registerSuite({
          name: 'async-suite',
          tasks: [
            {
              name: 'async task',
              fn: async () => { await Promise.resolve(); },
            },
          ],
        });
      }).not.toThrow();
    });

    it('accepts multiple tasks in one suite', () => {
      expect(() => {
        registerSuite({
          name: 'multi-task-suite',
          tasks: [
            { name: 'task-1', fn: () => { Math.sqrt(2); } },
            { name: 'task-2', fn: () => { Math.sqrt(4); } },
            { name: 'task-3', fn: () => { Math.sqrt(8); } },
          ],
        });
      }).not.toThrow();
    });

    it('accepts optional iterations count', () => {
      expect(() => {
        registerSuite({
          name: 'custom-iterations-suite',
          iterations: 50,
          tasks: [{ name: 'task', fn: () => { /* no-op */ } }],
        });
      }).not.toThrow();
    });
  });
});

