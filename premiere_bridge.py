"""
premiere_bridge.py
Best-effort bridge from silence_cutter.py output into Adobe Premiere Pro on macOS.
Generates Premiere-readable XML, then optionally asks macOS to open it with Premiere.
"""

import argparse
import os
import subprocess
import sys
from typing import Optional

from silence_cutter import run as run_silence_cutter


PREMIERE_BUNDLE_ID = "com.adobe.PremierePro"


def locate_premiere() -> Optional[str]:
    candidates = [
        "/Applications/Adobe Premiere Pro.app",
    ]
    candidates.extend(
        f"/Applications/Adobe Premiere Pro {year}/Adobe Premiere Pro {year}.app"
        for year in range(2020, 2031)
    )

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    result = subprocess.run(
        ["mdfind", f'kMDItemCFBundleIdentifier == "{PREMIERE_BUNDLE_ID}"'],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if line.endswith(".app") and os.path.exists(line):
                return line

    return None


def open_in_premiere(xml_path: str) -> bool:
    app_path = locate_premiere()
    if not app_path:
        print("  ⚠️  Adobe Premiere Pro app not found on this Mac.")
        return False

    result = subprocess.run(
        ["open", "-a", app_path, xml_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  ⚠️  Could not hand off XML to Premiere:\n{result.stderr.strip()}")
        return False

    print(f"  ✅ Premiere handoff requested via: {app_path}")
    return True


def reveal_in_finder(path: str) -> None:
    subprocess.run(["open", "-R", path], capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a Premiere XML timeline and hand it off to Adobe Premiere Pro."
    )
    parser.add_argument("video", help="Input video file path")
    parser.add_argument("--mode", choices=["silence", "speech-clean", "hybrid"], default="silence",
        help="Cleanup mode to run before exporting the Premiere XML")
    parser.add_argument("--output-dir", default=None,
        help="Output directory for generated XML (default: same as input)")
    parser.add_argument("--threshold", type=float, default=None,
        help="Silence threshold in dB (auto-detected if omitted)")
    parser.add_argument("--min-silence", type=float, default=None,
        help="Minimum silence duration in seconds (auto-detected if omitted)")
    parser.add_argument("--padding", type=float, default=None,
        help="Padding around cuts in seconds")
    parser.add_argument("--language", default="en",
        help="Transcription language for speech-clean/hybrid")
    parser.add_argument("--speech-model", default="base",
        help="faster-whisper model name for speech-clean/hybrid")
    parser.add_argument("--filler-words", default=None,
        help="Comma-separated filler words/phrases to remove")
    parser.add_argument("--aggressiveness", choices=["low", "medium", "high"], default="medium",
        help="Controls repeat/filler defaults")
    parser.add_argument("--repeat-gap", type=float, default=None,
        help="Max gap between repeated words/phrases")
    parser.add_argument("--filler-max-duration", type=float, default=None,
        help="Ignore filler tokens longer than this many seconds")
    parser.add_argument("--no-markers", action="store_true",
        help="Do not add cut markers to the Premiere XML")
    parser.add_argument("--skip-open", action="store_true",
        help="Only generate XML; do not ask macOS to open it in Premiere")
    parser.add_argument("--reveal", action="store_true",
        help="Reveal the generated XML in Finder after export")
    args = parser.parse_args()

    try:
        outputs = run_silence_cutter(
            video_path=args.video,
            output_dir=args.output_dir,
            threshold=args.threshold,
            min_silence=args.min_silence,
            padding=args.padding,
            mode=args.mode,
            language=args.language,
            speech_model=args.speech_model,
            filler_words=args.filler_words,
            aggressiveness=args.aggressiveness,
            repeat_gap=args.repeat_gap,
            filler_max_duration=args.filler_max_duration,
            include_markers=not args.no_markers,
            export_xml=True,
            export_mp4=False,
        )
    except Exception as exc:
        print(f"\n❌ Error: {exc}", file=sys.stderr)
        return 1

    xml_path = outputs.get("xml")
    if not xml_path:
        print("\n❌ XML export did not produce a file path.", file=sys.stderr)
        return 1

    print("\n📥 Premiere import guidance")
    if not args.skip_open:
        opened = open_in_premiere(xml_path)
        if not opened:
            print("  1. Open Premiere Pro")
            print("  2. File -> Import")
            print(f"  3. Select: {xml_path}")
            print("  4. Import as sequence when prompted")
    else:
        print(f"  XML ready: {xml_path}")
        print("  Import manually in Premiere via File -> Import.")

    if args.reveal:
        reveal_in_finder(xml_path)
        print("  👀 Revealed XML in Finder.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
