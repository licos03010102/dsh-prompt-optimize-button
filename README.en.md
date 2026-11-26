# Prompt optimization button for DSH

[简体中文](README.md) · English

Turn a rough draft into a prompt you can review before sending. The plugin adds a sparkle button to the left of the DSH Web composer and uses a text model already configured in DSH. It rewrites the request rather than answering it. Nothing is sent to the chat automatically.

![Diagram of the optimization panel and its button next to the composer](docs/preview.svg)

## What it can do

| Mode | Use it for |
| --- | --- |
| Plain prompt | Clarifying a task, constraints, and expected output. |
| System prompt / persona | Turning vague preferences into concrete behavior rules. |
| Revise a draft | Making a focused change to an existing prompt, such as shortening it or adding an example. |

For example, “Help me prepare a meeting summary” could become “Use only the meeting notes below. List decisions, action items, owners, and deadlines. Mark missing information as ‘to be confirmed’ instead of guessing.”

## Install and use

Requires DSH Web `>=0.2.2-rc.2 <0.3.0` and a configured text model. Download the [release package](https://github.com/licos03010102/dsh-prompt-optimize-button/releases/latest/download/dsh-prompt-optimize-button.tgz) and install it via DSH's plugin manager. If you added this plugin manually to your profile in the past, remove that manual entry before installing the bundle.

The plugin panel currently uses Simplified Chinese. Write a draft, click the sparkle next to the composer, choose a mode and model, and click **开始优化** (Start). Review the result, then select **填入输入框** (Fill composer), **复制** (Copy), or **继续改** (Revise further).

Each optimization sends the draft and any additional requirements to the selected model. Recent visible conversation messages are included only when you opt in. Long context may incur an extra summarization request; if that request fails, the plugin can use the collected context without summarizing it. The result is shown after the model finishes.

## Development

Run `npm ci` and `npm test` in the checkout. See the [design notes](docs/DESIGN.md) for the prompt templates, experiments, and implementation trade-offs. [MIT license](LICENSE).
