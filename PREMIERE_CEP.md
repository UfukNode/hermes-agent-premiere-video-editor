# HERMES CEP Panel

This project includes a CEP fallback panel for Premiere Pro in:

`cep-extension/`

Why this exists:

- UXP connection in UDT can fail even when Premiere is current
- CEP is older, but it is often the more practical fallback for stable Premiere builds
- the Python cleanup backend stays the same

## Platform Support

This CEP setup is macOS-only right now.

The install path, helper scripts, and local command assumptions in this repo target macOS. Windows and Linux are out of scope for the current panel installer.

## What The CEP Panel Does

- reads the selected clip from the active Premiere sequence
- lets you choose `Silence`, `Speech`, or `Hybrid`
- lets you choose `EN` or `TR`
- sends the clip path to the local backend
- applies the cleaned result back onto the same active sequence

## Install On macOS

1. Enable CEP debug mode:

```bash
cd /path/to/hermes-agent-premiere-video-editor
npm run enable:cep-debug
```

2. Install the panel into the user CEP extensions folder:

```bash
cd /path/to/hermes-agent-premiere-video-editor
npm run install:cep
```

This links the extension into:

`~/Library/Application Support/Adobe/CEP/extensions/com.hermesagent.premierevideoeditor.cep`

3. Start the local backend:

```bash
cd /path/to/hermes-agent-premiere-video-editor
npm start
```

4. Restart Premiere Pro.

5. Open the panel in Premiere:

`Window -> Extensions (Legacy) -> HERMES`

## Usage

1. Select one clip in the active Premiere timeline
2. Open `HERMES`
3. Choose mode
4. Choose language
5. Click `Start`

## Notes

- CEP panels appear under `Extensions (Legacy)`.
- The panel reads the active sequence selection first. Select a timeline clip before running.
- If the panel opens but the backend is offline, start the backend with `npm start`.
- Runtime logs are expected to stay visible in the external terminal where `npm start` is running.
