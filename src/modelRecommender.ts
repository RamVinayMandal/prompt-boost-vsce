import * as vscode from 'vscode';

export type TaskType =
  | 'code-gen'
  | 'debug'
  | 'test'
  | 'docs'
  | 'refactor'
  | 'architecture'
  | 'data'
  | 'other';

interface ModelRecommendation {
  displayName: string;
  family: string;
}

const TASK_MODEL_MAP: Record<TaskType, ModelRecommendation[]> = {
  'code-gen':      [{ displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4.6' }],
  'debug':         [{ displayName: 'Claude Opus 4.6',   family: 'claude-opus-4.6' },
                    { displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4.6' }],
  'test':          [{ displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4.6' }],
  'docs':          [{ displayName: 'GPT 5.4',           family: 'gpt-5.4' }],
  'refactor':      [{ displayName: 'GPT 5.4',           family: 'gpt-5.4' }],
  'architecture':  [{ displayName: 'Claude Opus 4.6',   family: 'claude-opus-4.6' }],
  'data':          [{ displayName: 'GPT 5.4',           family: 'gpt-5.4' },
                    { displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4.6' }],
  'other':         [{ displayName: 'Claude Sonnet 4.6', family: 'claude-sonnet-4.6' }],
};

export async function getRecommendedModel(task: string): Promise<string> {
  const taskType = normalizeTask(task);
  const candidates = TASK_MODEL_MAP[taskType];

  for (const candidate of candidates) {
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: candidate.family,
    });
    if (models.length > 0) {
      return candidate.displayName;
    }
  }

  return candidates[0].displayName;
}

function normalizeTask(raw: string): TaskType {
  const cleaned = raw.toLowerCase().trim().replace(/[^a-z-]/g, '');
  if (cleaned in TASK_MODEL_MAP) {
    return cleaned as TaskType;
  }
  return 'other';
}
