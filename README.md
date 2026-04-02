# Prompt Boost

A GitHub Copilot Chat extension that improves your rough prompts into clear, specific, and actionable ones — and recommends the best model for each task.

## Usage

```
@prompt-boost <your rough prompt>
```

Type a rough description of what you want Copilot to do. Prompt Boost will:

- Rewrite it to be specific, unambiguous, and directly actionable
- Score the original and improved prompt quality (0–100)
- Recommend the best Copilot model for the detected task type
- Let you **Edit**, **Send**, or **Send Original** from the chat panel

## Features

### Quality mode (default)
Produces a fully engineered prompt with assumption marking and history-aware context embedding. Uses conversation history to fill in file names, frameworks, constraints, and prior decisions directly into the improved prompt.

### Token-saving mode
Engineers the prompt for minimal downstream token consumption — compact style, mode-specific output rules, no assumption marking.

Toggle with:
```
@prompt-boost /tokensave on
@prompt-boost /tokensave off
```

### Mode detection
Automatically detects the intended Copilot mode from the prompt:
- **Agent** — code changes, file edits, commands
- **Plan** — step-by-step outline without execution
- **Ask** — explanation, review, or documentation

When you have a mode explicitly selected in the VS Code chat UI, Prompt Boost respects it over its own inference.

### Model recommendation
Recommends the best available Copilot model based on the detected task type:

| Task | Recommended model |
|---|---|
| code-gen, test | Claude Sonnet 4.6 |
| debug | Claude Opus 4.6 |
| docs, refactor, data | GPT 5.4 |
| architecture | Claude Opus 4.6 |

### Select boost model
Choose which model Prompt Boost itself uses to improve your prompts:

**Command Palette → `Prompt Boost: Select Boost Model`**

Shows all models available in your current environment. Select **Automatic (default)** to restore built-in model selection behavior.

## Requirements

- VS Code 1.91+
- GitHub Copilot Chat extension
- Active GitHub Copilot subscription

## Extension Settings

No settings file required. All preferences (token-saving mode, preferred boost model) are persisted automatically per user.
