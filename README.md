# Hermes Agent Premiere Video Editor

Hermes Agent Premiere Video Editor is a local Adobe Premiere Pro panel that runs Hermes Agent as the orchestration layer for talking-head cleanup workflows.

The panel is designed for a simple in-editor flow:

1. Select a clip in the active Premiere sequence.
2. Choose a cleanup mode.
3. Press `Start`.
4. Let Hermes Agent run in the terminal.
5. Apply the cleanup result back into the same Premiere sequence.

This project is not just a Python script and not just a Premiere panel. It is a local editing toolchain built from three parts:

- a CEP panel inside Premiere Pro
- a local Node backend that launches Hermes Agent and the cleanup pipeline
- a deterministic video cleanup engine for silence removal and transcript-based speech cleanup

## What It Does

The tool can:

- remove silence from a selected clip
- remove filler words and repeated words from speech-heavy clips
- run a hybrid pass that combines speech cleanup and silence cleanup
- keep Hermes Agent visible in the terminal while the edit is being prepared
- write the result back into the active Premiere timeline instead of forcing a separate manual XML import workflow

## Why Hermes Agent Is In The Loop

When you press `Start`, the backend launches Hermes Agent first. That stage is visible in the terminal and is meant to show the agent-driven orchestration layer clearly during demos and recordings.

After the Hermes stage finishes, the deterministic cleanup stage runs locally and the panel applies the cut plan to the selected clip inside Premiere Pro.

That split is intentional:

- Hermes Agent stays visible and real in the runtime
- the actual media operation remains deterministic and repeatable
- Premiere integration stays fast enough for editing workflows

## Current Premiere Integration

The current shipping path in this repo is the CEP panel, not the UXP panel.

UXP support in Premiere is still inconsistent across machines and developer tool setups. CEP is the practical fallback that works better for local installation and demos. The CEP panel is the part you should use.

## Modes

The panel exposes three cleanup modes:

- `Silence`
- `Speech`
- `Hybrid`

Language selection is separate from mode selection and currently supports:

- `EN`
- `TR`

## How It Works

The end-to-end runtime looks like this:

1. Premiere panel reads the selected clip context.
2. The Node backend starts Hermes Agent in verbose mode.
3. Hermes Agent loads the `silence-cutter` skill and appears in the terminal.
4. The backend runs the deterministic cleanup engine.
5. The cleanup engine returns a cut plan.
6. The CEP host script applies that cut plan back onto the selected clip in the active sequence.

## Project Structure

- `index.js`: local backend that launches Hermes Agent and the cleanup engine
- `silence_cutter.py`: cleanup engine for silence, filler words, repetitions, and hybrid passes
- `premiere_bridge.py`: XML-oriented Premiere bridge for non-panel workflows
- `cep-extension/client/index.html`: Premiere CEP panel UI
- `cep-extension/client/main.js`: panel runtime logic
- `cep-extension/host/index.jsx`: ExtendScript host integration for Premiere
- `SKILL.md`: Hermes skill definition for the cleanup workflow

## Platform Support

This repo currently supports macOS only.

Windows and Linux are not supported in the current setup. The CEP install path, helper shell scripts, `python3` command usage, and `/dev/null`-based ffmpeg probing are all wired for macOS-style local environments.

## Requirements

- macOS
- Adobe Premiere Pro
- Node.js
- Python 3
- `ffmpeg`
- `ffprobe`
- Hermes Agent installed and authenticated locally

For speech cleanup and hybrid cleanup, install:

```bash
pip install faster-whisper
```

## Installation

Install dependencies first:

```bash
brew install ffmpeg
python3 -m pip install --user --break-system-packages -r requirements.txt
```

Make sure Hermes Agent is installed and working on your machine.

Official Hermes Agent repo:

`https://github.com/NousResearch/hermes-agent`

These install commands assume a macOS machine with Homebrew available.

Enable CEP debug mode and install the panel:

```bash
cd /path/to/hermes-agent-premiere-video-editor
npm run enable:cep-debug
npm run install:cep
```

Start the local backend:

```bash
cd /path/to/hermes-agent-premiere-video-editor
npm start
```

Restart Premiere Pro, then open:

`Window -> Extensions (Legacy) -> HERMES`

## Daily Usage

1. Keep the terminal open with `npm start`.
2. Open the `HERMES` panel in Premiere.
3. Select one clip in the active sequence.
4. Choose a mode.
5. Choose a language.
6. Press `Start`.

The terminal is expected to show Hermes Agent output during the run. That is part of the intended workflow.

## Output Strategy

For the current panel flow, the main path is in-sequence application inside Premiere.

The older XML-oriented path still exists in the repo for fallback workflows, but the CEP panel is the intended product flow.

## Notes

- The panel is intentionally minimal and keeps the visible agent logs in the terminal instead of duplicating them inside Premiere.
- The cleanup engine remains deterministic even though Hermes Agent is used as the orchestration surface.
- The same-sequence edit flow is the current target behavior for demos and product presentation.
