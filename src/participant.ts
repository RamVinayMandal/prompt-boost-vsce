import * as vscode from 'vscode';
import { boostPrompt } from './improver';
import { getRecommendedModel } from './modelRecommender';

const TOKEN_SAVING_KEY = 'tokenSaving';
const PREFERRED_BOOST_MODEL_ID_KEY = 'preferredBoostModelId';
const ACTION_WORD_PATTERNS = [
  /\b(fix|add|create|update|remove|delete|refactor|explain|generate|write|help)\b/i,
  /\b(show|find|check|test|review|debug|implement|build|change|make)\b/i,
  /\b(get|set|run|use|improve|analyze|list|describe)\b/i,
];

export function registerParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    'prompt-boost.participant',
    (request, chatContext, stream, token) =>
      handleRequest(request, chatContext, stream, token, context),
  );

  participant.iconPath = new vscode.ThemeIcon('sparkle');

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand('prompt-boost.openChat', async (query: string, isPartial: boolean) => {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query,
        isPartialQuery: isPartial,
      });
    }),
    vscode.commands.registerCommand('prompt-boost.selectBoostModel', async () => {
      await selectBoostModel(context);
    }),
  );
}

function isTokenSavingOn(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(TOKEN_SAVING_KEY, false);
}

function getPreferredBoostModelId(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(PREFERRED_BOOST_MODEL_ID_KEY);
}

const SCORE_BAR = (score: number) =>
  '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));

const TRIVIAL_PATTERNS = /^(hi|hello|hey|yo|sup|hiya|howdy|greetings|thanks|thank you|ok|okay|yes|no|sure|nope|bye|goodbye)[^a-z]*$/i;

function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 8) { return true; }
  if (TRIVIAL_PATTERNS.test(trimmed)) { return true; }
  const hasActionWord = ACTION_WORD_PATTERNS.some(pattern => pattern.test(trimmed));
  if (trimmed.split(/\s+/).length === 1 && !hasActionWord) { return true; }
  return false;
}

interface BoostModelQuickPickItem extends vscode.QuickPickItem {
  modelId?: string;
}

async function selectBoostModel(context: vscode.ExtensionContext): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (models.length === 0) {
    void vscode.window.showWarningMessage('No Copilot chat models are currently available for Prompt Boost.');
    return;
  }

  const currentModelId = getPreferredBoostModelId(context);
  const modelPicks: BoostModelQuickPickItem[] = models
    .slice()
    .sort((left, right) => {
      const leftLabel = `${left.name} ${left.version}`.trim();
      const rightLabel = `${right.name} ${right.version}`.trim();
      return leftLabel.localeCompare(rightLabel);
    })
    .map(model => ({
      label: `${model.name} ${model.version}`.trim(),
      description: model.family,
      detail: model.id === currentModelId ? 'Currently selected for prompt boosting' : model.id,
      modelId: model.id,
    }));

  const selection = await vscode.window.showQuickPick<BoostModelQuickPickItem>(
    [
      {
        label: 'Automatic (default)',
        description: 'Use the existing built-in model selection and fallback behavior',
        detail: currentModelId ? undefined : 'Currently selected for prompt boosting',
      },
      ...modelPicks,
    ],
    {
      placeHolder: 'Select the model Prompt Boost should use to improve prompts',
    },
  );

  if (!selection) {
    return;
  }

  if (!selection.modelId) {
    await context.globalState.update(PREFERRED_BOOST_MODEL_ID_KEY, undefined);
    void vscode.window.showInformationMessage('Prompt Boost will use automatic model selection.');
    return;
  }

  await context.globalState.update(PREFERRED_BOOST_MODEL_ID_KEY, selection.modelId);
  void vscode.window.showInformationMessage(`Prompt Boost model set to ${selection.label}.`);
}

/**
 * Keep history compact so the improver gets useful context without paying unnecessary meta-model cost.
 */
function formatHistory(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
  tokenSaving: boolean,
): string | null {
  if (history.length === 0) { return null; }

  const maxTurns = tokenSaving ? 4 : 8;
  const maxChars = tokenSaving ? 300 : 600;

  const lines: string[] = [];
  for (const turn of history.slice(-maxTurns)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const text = turn.prompt.trim();
      if (text) { lines.push(`User: ${text.slice(0, maxChars)}`); }
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
        .join(' ')
        .trim();
      if (text) { lines.push(`Copilot: ${text.slice(0, maxChars)}`); }
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

async function handleRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
): Promise<vscode.ChatResult> {
  if (request.command === 'tokensave') {
    return handleTokenSaveCommand(request.prompt, stream, context);
  }

  const roughPrompt = request.prompt.trim();
  if (!roughPrompt) {
    stream.markdown('Please provide a prompt to boost. Example:\n\n`@prompt-boost fix the login bug`');
    return {};
  }

  if (isTrivialPrompt(roughPrompt)) {
    stream.markdown(
      `⚠️ **Prompt too vague to boost.**\n\n` +
      `"${roughPrompt}" doesn't contain enough context for Copilot to act on.\n\n` +
      `Try describing what you want to do, for example:\n` +
      `- \`@prompt-boost fix the null pointer in the login service\`\n` +
      `- \`@prompt-boost add pagination to the user list component\``,
    );
    return {};
  }

  const tokenSaving = isTokenSavingOn(context);
  const preferredBoostModelId = getPreferredBoostModelId(context);

  const historyContext = formatHistory([...chatContext.history], tokenSaving);
  // Read the user-selected VS Code chat mode at runtime (present in VS Code 1.97+, not in @types/vscode 1.91)
  const userSelectedMode = (request as unknown as Record<string, unknown>).mode as string | undefined;

  stream.progress('Boosting your prompt...');

  const result = await boostPrompt(
    roughPrompt,
    tokenSaving,
    token,
    historyContext || undefined,
    userSelectedMode,
    preferredBoostModelId,
  );

  if (!result) {
    stream.markdown(
      '⚠️ Could not boost your prompt. No Copilot language model is available. ' +
      'Make sure you have an active GitHub Copilot subscription.',
    );
    return {};
  }

  const recommendedModel = await getRecommendedModel(result.task);

  stream.markdown('### ✨ Boosted Prompt\n\n');
  stream.markdown(result.improved.split('\n').map(l => `> ${l}`).join('\n') + '\n\n');

  stream.markdown(
    `**Prompt quality**\n` +
    `| | Score | Visual |\n` +
    `|---|---|---|\n` +
    `| Original | ${result.originalScore}/100 | \`${SCORE_BAR(result.originalScore)}\` |\n` +
    `| Boosted  | ${result.boostedScore}/100 | \`${SCORE_BAR(result.boostedScore)}\` |\n\n`,
  );

  stream.markdown(`**Recommended model:** ${recommendedModel}  \n**Task type:** ${result.task}  \n\n`);

  stream.button({
    command: 'prompt-boost.openChat',
    arguments: [result.improved, true],
    title: '✏️ Edit',
  });

  stream.button({
    command: 'prompt-boost.openChat',
    arguments: [result.improved, false],
    title: '▶ Send',
  });

  stream.button({
    command: 'prompt-boost.openChat',
    arguments: [roughPrompt, false],
    title: '▶ Send Original',
  });

  stream.markdown(`\n\n---\n*Token-saving: ${tokenSaving ? 'ON' : 'OFF'}*`);

  return {};
}

async function handleTokenSaveCommand(
  prompt: string,
  stream: vscode.ChatResponseStream,
  context: vscode.ExtensionContext,
): Promise<vscode.ChatResult> {
  const arg = prompt.trim().toLowerCase();

  if (arg === 'on') {
    await context.globalState.update(TOKEN_SAVING_KEY, true);
    stream.markdown('✅ **Token-saving mode: ON**\n\nBoosted prompts will now include response-efficiency constraints to reduce downstream token usage — compact formatting, direct output rules, and mode-specific structure.');
    return {};
  }

  if (arg === 'off') {
    await context.globalState.update(TOKEN_SAVING_KEY, false);
    stream.markdown('✅ **Token-saving mode: OFF**\n\nBoosted prompts will focus on clarity, specificity, and task quality without response-efficiency formatting constraints.');
    return {};
  }

  const current = isTokenSavingOn(context);
  stream.markdown(
    `**Token-saving mode is currently ${current ? 'ON' : 'OFF'}**\n\n` +
    'Usage:\n' +
    '- `@prompt-boost /tokensave on` — Enable token-saving\n' +
    '- `@prompt-boost /tokensave off` — Disable token-saving',
  );
  return {};
}
