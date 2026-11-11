import type { AllState } from '../types';
import { readJSON, writeJSON } from './helpers';

export class StateManager {
  private stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  async getState(pair: string): Promise<AllState> {
    const state = await readJSON<AllState>(this.stateFile);
    if (state && state.pair === pair) {
      return { pair, steps: Array.isArray(state.steps) ? state.steps : [], updated: state.updated };
    }
    return { pair, steps: [], updated: new Date().toISOString() };
  }

  async setState(pair: string, steps: string[]): Promise<void> {
    await writeJSON(this.stateFile, {
      pair,
      steps,
      updated: new Date().toISOString(),
    } satisfies AllState);
  }

  async isStepDone(pair: string, step: string): Promise<boolean> {
    const state = await this.getState(pair);
    return state.steps.includes(step);
  }

  async markStepDone(pair: string, step: string): Promise<void> {
    const state = await this.getState(pair);
    if (!state.steps.includes(step)) {
      state.steps.push(step);
      await this.setState(pair, state.steps);
    }
  }

  async reset(pair: string): Promise<void> {
    await this.setState(pair, []);
  }
}

export function createStateManager(stateFile: string): StateManager {
  return new StateManager(stateFile);
}
