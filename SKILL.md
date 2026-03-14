---
name: silence-cutter
description: >
  Cleans up videos for editing workflows. Supports silence removal,
  transcript-driven filler/repetition cleanup, and hybrid mode. Exports
  an edit-friendly Premiere XML timeline with visible cut boundaries and
  optional markers, plus an optional cut MP4.
version: 2.0.0
metadata:
  hermes:
    tags: [video, editing, ffmpeg, premiere, transcript, content-creation]
    category: media
    requires: [ffmpeg, ffprobe, python3]
---

# Silence Cutter

Use this skill when the user wants a rough cut prepared for Adobe Premiere Pro.
It can:

- remove silence
- remove spoken filler words like `uh`, `um`, `you know`, `i mean`
- remove obvious repeated words / short repeated phrases
- export a Premiere-importable XML timeline with editable cut boundaries
- optionally export a cut MP4

The Premiere timeline stays editable. Editors can drag cuts earlier/later,
extend clips, or remove cuts manually.

`SKILL_DIR` is the directory containing this `SKILL.md` file.

## When To Use

Trigger this skill when the user says things like:

- "cut the silence from this video"
- "remove dead air"
- "clean up my talking head video"
- "remove um and uh"
- "clean repeated words from my English video"
- "make me a Premiere timeline from this raw recording"

## Prerequisites

```bash
ffmpeg -version
ffprobe -version
python3 --version
```

For `speech-clean` and `hybrid` modes, install the transcript dependency:

```bash
pip install faster-whisper
```

## Modes

- `silence`: remove silent gaps only
- `speech-clean`: remove spoken filler words and obvious repeated words/phrases
- `hybrid`: run speech cleanup and silence cleanup together

## Core Commands

```bash
# Silence only
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 --mode silence

# Speech cleanup only (English-first workflow)
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 --mode speech-clean --language en

# Both together
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 --mode hybrid --language en

# Premiere XML only
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 --mode hybrid --xml-only

# More conservative speech cleanup
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 --mode speech-clean --aggressiveness low

# Custom filler list
python3 SKILL_DIR/silence_cutter.py /path/to/video.mp4 \
  --mode speech-clean \
  --filler-words "uh,um,erm,like,you know,i mean"
```

## Premiere Handoff

```bash
python3 SKILL_DIR/premiere_bridge.py /path/to/video.mp4 --mode hybrid --language en
```

This generates the Premiere XML and asks macOS to open it with Adobe Premiere Pro.

## How To Report Results

After running, tell the user:

- which mode was used
- how many cut segments were found
- how much time was removed
- where the XML and MP4 were saved
- that the Premiere timeline is still editable
- that markers may show where silence/filler/repetition cuts happened

## Premiere Import Instructions

Tell the user:

```text
To import into Adobe Premiere Pro:
1. Open Premiere Pro
2. File -> Import
3. Select the generated _timeline.xml file
4. Premiere creates a new sequence with all cuts applied
5. Clip boundaries remain editable in the timeline
6. If markers were included, use them to review aggressive cuts quickly
```

## Important Parameters

| Parameter | Description |
|---|---|
| `--mode silence|speech-clean|hybrid` | Select cleanup strategy |
| `--language en` | Transcript language for speech cleanup |
| `--speech-model base` | faster-whisper model size |
| `--aggressiveness low|medium|high` | Controls repeat/filler sensitivity |
| `--filler-words` | Custom comma-separated filler list |
| `--repeat-gap` | Max gap between repeated words/phrases |
| `--padding` | Handle around cut edges |
| `--no-markers` | Export XML without cut markers |
| `--xml-only` | Export XML only |
| `--mp4-only` | Export MP4 only |

## Output Files

| File | Description |
|---|---|
| `{name}_timeline.xml` | Silence mode Premiere timeline |
| `{name}_speech_clean_timeline.xml` | Speech-clean Premiere timeline |
| `{name}_hybrid_timeline.xml` | Hybrid Premiere timeline |
| `{name}_cut.mp4` | Silence mode cut video |
| `{name}_speech_clean_cut.mp4` | Speech-clean cut video |
| `{name}_hybrid_cut.mp4` | Hybrid cut video |

## Pitfalls

- `speech-clean` needs `faster-whisper`; without it the command fails with an install hint.
- The speech cleanup workflow is tuned for English first. Other languages need a custom filler list and should be reviewed manually.
- Repetition cleanup is heuristic-based. Review aggressive cuts in Premiere using clip boundaries and markers.
- If the XML feels too aggressive, rerun with `--aggressiveness low`.
- If silence cuts are too strong, raise `--min-silence` or use a less aggressive threshold.

## Verification

1. Run the script and confirm the report looks reasonable.
2. Import the generated XML into Premiere.
3. Check that cuts appear as separate clip boundaries in the new sequence.
4. Inspect markers for silence / filler / repetition removal points.
5. Extend or trim clips manually inside Premiere where needed.

## Example Session

```text
User: "Clean up my English talking head video for Premiere. Remove ums and silences."

Hermes runs:
python3 SKILL_DIR/silence_cutter.py /Users/me/Desktop/raw.mp4 --mode hybrid --language en --xml-only

Result summary:
- Mode: hybrid
- Removed silence + filler/repetition segments
- Saved Premiere XML to /Users/me/Desktop/raw_hybrid_timeline.xml
- Timeline remains editable inside Premiere
```
