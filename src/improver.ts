import * as vscode from 'vscode';

export interface BoostResult {
  improved: string;
  task: string;
  mode: 'ask' | 'plan' | 'agent';
  originalScore: number;
  boostedScore: number;
}

const JSON_INSTRUCTION = `\nRespond ONLY with JSON: {"improved":"...","task":"...","mode":"ask|plan|agent","originalScore":<0-100>,"boostedScore":<0-100>}
Score rubric — rate each prompt 0–100 on: specificity (are the exact task, files, and constraints stated?), actionability (can Copilot act on it without guessing?), and completeness (are edge cases and output format covered?). Average the three.
No explanation. No markdown. No preamble.`;

const SYSTEM_PROMPT_BASE = `You are a prompt improver. Your primary goal is to make the rough prompt clear, specific, and effective so Copilot produces a high-quality result.

CRITICAL RULE — no hallucination: Never invent, infer, or assume names, tools, frameworks, file paths, baselines, or prior context that are not explicitly present in the user's prompt or the provided conversation history. If something is not stated, do not add it. Use only what is given.

Steps:
1. Detect the intended Copilot mode. If a "User-selected mode" is provided in the input below, treat it as authoritative — use it as-is and do not override it. Otherwise infer from the prompt:
   - "agent": making code changes, fixing bugs, creating/deleting files, running commands; also when the phrasing shows action intent (e.g. "can we add this?", "is there a way to fix?", "can we implement?") even if worded as a question
   - "plan": plan or outline changes without executing
   - "ask": explanation, review, or documentation where there is clearly no intent to make changes
2. Engineer the prompt: make it specific, unambiguous, and directly actionable for Copilot. Focus on WHAT is needed, not just rephrasing the English.
   - agent + debug/refactor only: add "Read relevant files to understand context and root cause first."
   - Only if known context is explicitly provided in the history below:
     a) Embed specifics (file names, frameworks, constraints, prior decisions) directly into the improved prompt text — making the prompt explicit and self-contained means Copilot does not have to scan back through conversation history to find relevant constraints
     b) Identify corner cases the developer likely missed based only on what has already been discussed
     c) Add those cases as explicit requirements inside the improved prompt — not as suggestions
   - If no history context is provided, only rephrase what the user stated. Do not add requirements.
3. Classify task: one of [code-gen, debug, test, docs, refactor, architecture, data, other]

Assumptions: If a detail is not in the prompt or known context, mark it as "[Assumption: <what> — verify]". Only mark genuinely uncertain details; skip when obvious.`;

const SYSTEM_PROMPT_QUALITY_ONLY = `${SYSTEM_PROMPT_BASE}${JSON_INSTRUCTION}`;

// Token-saving mode trims prompt overhead because the boosted prompt itself already carries output-structure rules.
const SYSTEM_PROMPT_TOKEN_SAVING = `You are a prompt improver. Rewrite the rough prompt to be concise and effective for Copilot.

CRITICAL RULE — no hallucination: Never invent, infer, or assume names, tools, frameworks, file paths, baselines, or prior context not explicitly stated in the user's prompt or provided history. Only use what is given.

1. Detect mode. If "User-selected mode" is provided below, use it as-is. Otherwise infer: agent (code changes/files/commands; also action-intent questions like "can we fix/add/implement this?") | plan (outline only) | ask (explain/review/docs with no change intent)
2. Engineer the prompt: make it specific, actionable, and unambiguous for Copilot. Agent+debug/refactor only: prepend "Read relevant files first."
3. Only if history context is explicitly provided: embed specifics (file names, frameworks, constraints, prior decisions) directly into the improved prompt text so it is explicit and self-contained, rather than relying on Copilot to scan back through conversation history. Add missed edge cases from the discussion as explicit requirements. Otherwise, only rephrase what the user stated.
4. Append a response-efficiency block at the very end of the improved prompt, chosen by mode and task:

   agent (any task):
     "---\nOutput rules: Show only changed lines/blocks, not full files. Inline comments to explain intent. No preamble, no summary, no alternatives."

   plan (any task):
     "---\nOutput rules: Numbered steps only. One line per step. No prose sections. No alternatives."

   ask + code-gen | debug | test | refactor:
     "---\nOutput rules: Code block first. Inline comments only — no prose paragraphs. No preamble. No restatement of the task."

   ask + docs | architecture:
     "---\nOutput rules: Bullet points. Concrete examples over abstractions. No repetition. No preamble."

   ask + data:
     "---\nOutput rules: Query/schema/script only. Inline comments for intent. No prose explanation."

   ask + other:
     "---\nOutput rules: Direct answer only. No preamble. No restatement."

5. Classify: code-gen|debug|test|docs|refactor|architecture|data|other${JSON_INSTRUCTION}`;

const MODEL_FALLBACK_FAMILIES = ['claude-haiku-4.6', 'claude-sonnet-4.6'];

async function selectPreferredModel(preferredModelId?: string): Promise<vscode.LanguageModelChat | undefined> {
  if (!preferredModelId) {
    return undefined;
  }

  const models = await vscode.lm.selectChatModels({ id: preferredModelId });
  return models.length > 0 ? models[0] : undefined;
}

async function selectModel(token: vscode.CancellationToken, preferredModelId?: string): Promise<vscode.LanguageModelChat | undefined> {
  const preferredModel = await selectPreferredModel(preferredModelId);
  if (preferredModel) {
    return preferredModel;
  }

  for (const family of MODEL_FALLBACK_FAMILIES) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    if (models.length > 0) {
      return models[0];
    }
  }
  const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return all.length > 0 ? all[0] : undefined;
}

function toBoostResult(parsed: Record<string, unknown>): BoostResult | undefined {
  if (typeof parsed.improved === 'string' && typeof parsed.task === 'string') {
    return {
      improved: parsed.improved,
      task: parsed.task,
      mode: normalizeMode(typeof parsed.mode === 'string' ? parsed.mode : ''),
      originalScore: clampScore(parsed.originalScore),
      boostedScore: clampScore(parsed.boostedScore),
    };
  }
  return undefined;
}

function clampScore(raw: unknown): number {
  const n = Number(raw);
  return Number.isNaN(n) ? 0 : Math.min(100, Math.max(0, Math.round(n)));
}

function parseBoostResult(raw: string): BoostResult | undefined {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  try {
    return toBoostResult(JSON.parse(cleaned));
  } catch {
    const jsonMatch = /\{[^}]*"improved"[^}]*\}/s.exec(cleaned);
    if (jsonMatch) {
      try { return toBoostResult(JSON.parse(jsonMatch[0])); } catch { /* give up */ }
    }
  }
  return undefined;
}

function normalizeMode(raw: string): 'ask' | 'plan' | 'agent' {
  if (raw === 'agent') { return 'agent'; }
  if (raw === 'plan') { return 'plan'; }
  return 'ask';
}

export async function boostPrompt(
  roughPrompt: string,
  tokenSaving: boolean,
  token: vscode.CancellationToken,
  historyFacts?: string,
  userSelectedMode?: string,
  preferredModelId?: string,
): Promise<BoostResult | undefined> {
  const model = await selectModel(token, preferredModelId);
  if (!model) {
    return undefined;
  }

  const systemPrompt = tokenSaving ? SYSTEM_PROMPT_TOKEN_SAVING : SYSTEM_PROMPT_QUALITY_ONLY;

  const modeHint = userSelectedMode ? `User-selected mode: ${userSelectedMode}\n` : '';
  const userMessage = historyFacts
    ? `${modeHint}Known context from conversation history:\n${historyFacts}\n\nPrompt to improve:\n${roughPrompt}`
    : `${modeHint}${roughPrompt}`;

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(userMessage),
  ];

  const response = await model.sendRequest(messages, {}, token);

  let fullResponse = '';
  for await (const chunk of response.text) {
    fullResponse += chunk;
  }

  const parsed = parseBoostResult(fullResponse);
  // VS Code mode selection should win over LLM inference so the UI behaves predictably.
  if (parsed && userSelectedMode) {
    parsed.mode = normalizeMode(userSelectedMode);
  }
  return parsed;
}
