"""
silence_cutter.py
Mode-based video cleanup for dead air and speech cleanup.
Exports a Premiere-importable XML timeline and/or a cut MP4.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring


DEFAULT_FILLERS = [
    "uh",
    "um",
    "erm",
    "ah",
    "like",
]

DEFAULT_FILLER_PHRASES = [
    "you know",
    "i mean",
    "sort of",
    "kind of",
]

AGGRESSIVENESS_PRESETS = {
    "low": {
        "repeat_gap": 0.25,
        "filler_max_duration": 0.6,
        "padding": 0.03,
    },
    "medium": {
        "repeat_gap": 0.45,
        "filler_max_duration": 0.9,
        "padding": 0.05,
    },
    "high": {
        "repeat_gap": 0.7,
        "filler_max_duration": 1.2,
        "padding": 0.08,
    },
}


@dataclass
class Segment:
    start: float
    end: float
    duration: float
    reason: str = "cut"
    label: str = ""

    def __repr__(self) -> str:
        reason = f" {self.reason}" if self.reason else ""
        return f"[{self.start:.3f}s -> {self.end:.3f}s ({self.duration:.3f}s){reason}]"


@dataclass
class WordToken:
    start: float
    end: float
    text: str
    probability: float = 0.0

    @property
    def normalized(self) -> str:
        return normalize_token(self.text)


def normalize_token(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9']+", "", text.lower())
    return normalized.strip("'")


def probe_media(video_path: str) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe error:\n{result.stderr}")
    if not result.stdout.strip():
        raise RuntimeError("ffprobe returned no media metadata")
    return json.loads(result.stdout)


def get_stream(media_info: dict[str, Any], codec_type: str) -> dict[str, Any] | None:
    for stream in media_info.get("streams", []):
        if stream.get("codec_type") == codec_type:
            return stream
    return None


def parse_frame_rate(rate: str) -> float:
    try:
        num, den = rate.split("/", 1)
        numerator = float(num)
        denominator = float(den)
        if denominator == 0:
            return 25.0
        return numerator / denominator
    except (ValueError, ZeroDivisionError):
        return 25.0


def get_media_properties(video_path: str) -> dict[str, Any]:
    media_info = probe_media(video_path)
    video_stream = get_stream(media_info, "video")
    audio_stream = get_stream(media_info, "audio")
    format_info = media_info.get("format", {})

    duration_str = format_info.get("duration")
    if not duration_str:
        raise RuntimeError("Could not determine media duration with ffprobe")

    fps = 25.0
    width = 1920
    height = 1080
    if video_stream:
        fps = parse_frame_rate(
            video_stream.get("avg_frame_rate")
            or video_stream.get("r_frame_rate")
            or "25/1"
        )
        width = int(video_stream.get("width") or width)
        height = int(video_stream.get("height") or height)

    channels = int(audio_stream.get("channels") or 2) if audio_stream else 0

    return {
        "duration": float(duration_str),
        "fps": fps,
        "width": width,
        "height": height,
        "has_audio": audio_stream is not None,
        "audio_channels": channels,
    }


def analyze_audio_levels(video_path: str) -> dict[str, float]:
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", "volumedetect",
        "-vn", "-sn", "-dn",
        "-f", "null", "/dev/null",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = result.stderr

    stats: dict[str, float] = {}
    for line in output.split("\n"):
        if "mean_volume" in line:
            match = re.search(r"mean_volume:\s*([-\d.]+)", line)
            if match:
                stats["mean_volume"] = float(match.group(1))
        if "max_volume" in line:
            match = re.search(r"max_volume:\s*([-\d.]+)", line)
            if match:
                stats["max_volume"] = float(match.group(1))

    return stats


def auto_detect_threshold(video_path: str) -> tuple[float, float]:
    stats = analyze_audio_levels(video_path)
    mean_volume = stats.get("mean_volume", -30.0)
    max_volume = stats.get("max_volume", -3.0)

    threshold = max(mean_volume - 15, -60)
    threshold = min(threshold, -25)

    duration = get_media_properties(video_path)["duration"]
    if duration < 120:
        min_silence = 0.4
    elif duration < 600:
        min_silence = 0.5
    else:
        min_silence = 0.6

    print(f"  Audio analysis: mean={mean_volume:.1f}dB, max={max_volume:.1f}dB")
    print(f"  Auto threshold: {threshold:.1f}dB, min silence: {min_silence}s")
    return threshold, min_silence


def detect_silence(video_path: str, noise_db: float, min_duration: float) -> list[Segment]:
    filter_str = f"silencedetect=noise={noise_db}dB:d={min_duration}"
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", filter_str,
        "-vn", "-sn", "-dn",
        "-f", "null", "/dev/null",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = result.stderr

    silence_starts: list[float] = []
    silence_ends: list[float] = []
    for line in output.split("\n"):
        start_match = re.search(r"silence_start:\s*([\d.]+)", line)
        end_match = re.search(r"silence_end:\s*([\d.]+)", line)
        if start_match:
            silence_starts.append(float(start_match.group(1)))
        if end_match:
            silence_ends.append(float(end_match.group(1)))

    segments: list[Segment] = []
    for index, start in enumerate(silence_starts):
        if index < len(silence_ends):
            end = silence_ends[index]
            segments.append(
                Segment(
                    start=start,
                    end=end,
                    duration=end - start,
                    reason="silence",
                    label="Removed silence",
                )
            )
    return segments


def load_transcriber(model_name: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "speech-clean mode requires faster-whisper. Install it with:\n"
            "  pip install faster-whisper"
        ) from exc

    return WhisperModel(model_name, device="cpu", compute_type="int8")


def transcribe_words(
    video_path: str,
    model_name: str,
    language: str,
) -> tuple[list[WordToken], str | None]:
    model = load_transcriber(model_name)
    segments, info = model.transcribe(
        video_path,
        language=language if language != "auto" else None,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )

    words: list[WordToken] = []
    for segment in segments:
        for word in getattr(segment, "words", []) or []:
            if word.start is None or word.end is None:
                continue
            words.append(
                WordToken(
                    start=float(word.start),
                    end=float(word.end),
                    text=str(word.word).strip(),
                    probability=float(getattr(word, "probability", 0.0) or 0.0),
                )
            )

    detected_language = getattr(info, "language", None)
    return words, detected_language


def parse_filler_inputs(raw_fillers: str) -> tuple[set[str], list[tuple[str, ...]]]:
    pieces = [part.strip() for part in raw_fillers.split(",") if part.strip()]
    single_tokens: set[str] = set()
    phrases: list[tuple[str, ...]] = []
    for piece in pieces:
        normalized_words = [normalize_token(word) for word in piece.split()]
        normalized_words = [word for word in normalized_words if word]
        if not normalized_words:
            continue
        if len(normalized_words) == 1:
            single_tokens.add(normalized_words[0])
        else:
            phrases.append(tuple(normalized_words))
    phrases.sort(key=len, reverse=True)
    return single_tokens, phrases


def detect_filler_segments(
    words: list[WordToken],
    single_fillers: set[str],
    phrase_fillers: list[tuple[str, ...]],
    filler_max_duration: float,
) -> list[Segment]:
    segments: list[Segment] = []
    index = 0
    while index < len(words):
        token = words[index]
        normalized = token.normalized
        if not normalized:
            index += 1
            continue

        matched_phrase = None
        for phrase in phrase_fillers:
            phrase_len = len(phrase)
            window = words[index:index + phrase_len]
            if len(window) != phrase_len:
                continue
            if tuple(word.normalized for word in window) == phrase:
                matched_phrase = window
                break

        if matched_phrase:
            start = matched_phrase[0].start
            end = matched_phrase[-1].end
            if end - start <= filler_max_duration * len(matched_phrase):
                phrase_text = " ".join(word.normalized for word in matched_phrase)
                segments.append(
                    Segment(
                        start=start,
                        end=end,
                        duration=end - start,
                        reason="filler",
                        label=f"Removed filler phrase: {phrase_text}",
                    )
                )
                index += len(matched_phrase)
                continue

        if normalized in single_fillers and (token.end - token.start) <= filler_max_duration:
            segments.append(
                Segment(
                    start=token.start,
                    end=token.end,
                    duration=token.end - token.start,
                    reason="filler",
                    label=f"Removed filler word: {normalized}",
                )
            )

        index += 1

    return segments


def detect_repeated_words(words: list[WordToken], repeat_gap: float) -> list[Segment]:
    segments: list[Segment] = []
    index = 0
    while index < len(words):
        base = words[index]
        normalized = base.normalized
        if not normalized:
            index += 1
            continue

        run_end = index + 1
        while run_end < len(words):
            next_token = words[run_end]
            if next_token.normalized != normalized:
                break
            if next_token.start - words[run_end - 1].end > repeat_gap:
                break
            run_end += 1

        if run_end - index >= 2:
            last_removed = words[run_end - 2]
            segments.append(
                Segment(
                    start=base.start,
                    end=last_removed.end,
                    duration=last_removed.end - base.start,
                    reason="repeat-word",
                    label=f"Removed repeated word: {normalized}",
                )
            )
            index = run_end
            continue

        index += 1

    return segments


def detect_repeated_phrases(words: list[WordToken], repeat_gap: float) -> list[Segment]:
    segments: list[Segment] = []
    max_phrase_len = 3
    index = 0
    while index < len(words):
        matched = False
        for size in range(max_phrase_len, 1, -1):
            left = words[index:index + size]
            right = words[index + size:index + (2 * size)]
            if len(left) != size or len(right) != size:
                continue
            left_phrase = tuple(word.normalized for word in left)
            right_phrase = tuple(word.normalized for word in right)
            if any(not word for word in left_phrase + right_phrase):
                continue
            if left_phrase != right_phrase:
                continue
            if right[0].start - left[-1].end > repeat_gap:
                continue

            phrase_text = " ".join(left_phrase)
            segments.append(
                Segment(
                    start=left[0].start,
                    end=left[-1].end,
                    duration=left[-1].end - left[0].start,
                    reason="repeat-phrase",
                    label=f"Removed repeated phrase: {phrase_text}",
                )
            )
            index += size
            matched = True
            break
        if not matched:
            index += 1
    return segments


def merge_segments(
    segments: list[Segment],
    bridge_gap: float = 0.04,
    total_duration: float | None = None,
) -> list[Segment]:
    if not segments:
        return []

    normalized: list[Segment] = []
    for segment in segments:
        start = max(0.0, segment.start)
        end = segment.end if total_duration is None else min(total_duration, segment.end)
        if end - start <= 0.01:
            continue
        normalized.append(
            Segment(
                start=start,
                end=end,
                duration=end - start,
                reason=segment.reason,
                label=segment.label,
            )
        )

    if not normalized:
        return []

    normalized.sort(key=lambda item: item.start)
    merged: list[Segment] = [normalized[0]]
    for segment in normalized[1:]:
        current = merged[-1]
        if segment.start <= current.end + bridge_gap:
            current.end = max(current.end, segment.end)
            current.duration = current.end - current.start
            reasons = sorted({part for part in [current.reason, segment.reason] if part})
            current.reason = "+".join(reasons)
            labels = [part for part in [current.label, segment.label] if part]
            current.label = " | ".join(dict.fromkeys(labels))
        else:
            merged.append(segment)
    return merged


def removals_to_keep_segments(
    remove_segments: list[Segment],
    total_duration: float,
    padding: float,
) -> tuple[list[Segment], list[dict[str, Any]]]:
    keep: list[Segment] = []
    markers: list[dict[str, Any]] = []
    cursor = 0.0
    timeline_cursor = 0.0

    for segment in remove_segments:
        edge_padding = min(padding, max(0.0, segment.duration / 3))
        keep_end = segment.start + edge_padding
        if keep_end > cursor + 0.01:
            keep_segment = Segment(
                start=cursor,
                end=keep_end,
                duration=keep_end - cursor,
                reason="keep",
                label="Kept segment",
            )
            keep.append(keep_segment)
            timeline_cursor += keep_segment.duration

        markers.append(
            {
                "timeline": timeline_cursor,
                "source_start": segment.start,
                "source_end": segment.end,
                "reason": segment.reason,
                "label": segment.label or f"Removed {segment.reason}",
            }
        )

        cursor = max(cursor, segment.end - edge_padding)

    if cursor < total_duration - 0.01:
        keep.append(
            Segment(
                start=cursor,
                end=total_duration,
                duration=total_duration - cursor,
                reason="keep",
                label="Kept segment",
            )
        )

    if not keep:
        keep.append(
            Segment(
                start=0.0,
                end=total_duration,
                duration=total_duration,
                reason="keep",
                label="Kept segment",
            )
        )

    return keep, markers


def generate_premiere_xml(
    keep_segments: list[Segment],
    cut_markers: list[dict[str, Any]],
    video_path: str,
    total_duration: float,
    fps: float,
    width: int,
    height: int,
    has_audio: bool,
    audio_channels: int,
    output_path: str,
    include_markers: bool = True,
) -> str:
    abs_video_path = os.path.abspath(video_path)
    output_duration = sum(segment.duration for segment in keep_segments)
    timebase = max(1, int(round(fps)))
    path_url = f"file://localhost{quote(abs_video_path)}"
    total_source_frames = int(round(total_duration * timebase))
    ntsc = "TRUE" if abs(fps - timebase) > 0.01 else "FALSE"

    def to_frames(seconds: float) -> int:
        return int(round(seconds * timebase))

    def add_rate(parent: Element) -> None:
        rate = SubElement(parent, "rate")
        SubElement(rate, "timebase").text = str(timebase)
        SubElement(rate, "ntsc").text = ntsc

    def add_sample_characteristics(parent: Element) -> None:
        sample = SubElement(parent, "samplecharacteristics")
        add_rate(sample)
        SubElement(sample, "width").text = str(width)
        SubElement(sample, "height").text = str(height)
        SubElement(sample, "anamorphic").text = "FALSE"
        SubElement(sample, "pixelaspectratio").text = "square"
        SubElement(sample, "fielddominance").text = "none"

    root = Element("xmeml", version="5")
    sequence = SubElement(root, "sequence")
    SubElement(sequence, "name").text = "Edited Timeline"
    SubElement(sequence, "duration").text = str(to_frames(output_duration))
    add_rate(sequence)

    timecode = SubElement(sequence, "timecode")
    add_rate(timecode)
    SubElement(timecode, "string").text = "00:00:00:00"
    SubElement(timecode, "frame").text = "0"
    SubElement(timecode, "displayformat").text = "NDF"

    if include_markers:
        for marker in cut_markers:
            marker_el = SubElement(sequence, "marker")
            SubElement(marker_el, "name").text = marker["label"][:64]
            comment = (
                f"{marker['reason']} | source "
                f"{marker['source_start']:.2f}s-{marker['source_end']:.2f}s"
            )
            SubElement(marker_el, "comment").text = comment
            frame = str(to_frames(marker["timeline"]))
            SubElement(marker_el, "in").text = frame
            SubElement(marker_el, "out").text = frame

    media = SubElement(sequence, "media")
    video = SubElement(media, "video")
    video_format = SubElement(video, "format")
    add_sample_characteristics(video_format)
    video_track = SubElement(video, "track")
    SubElement(video_track, "enabled").text = "TRUE"
    SubElement(video_track, "locked").text = "FALSE"

    audio_track = None
    if has_audio:
        audio = SubElement(media, "audio")
        audio_track = SubElement(audio, "track")
        SubElement(audio_track, "enabled").text = "TRUE"
        SubElement(audio_track, "locked").text = "FALSE"

    def add_file_element(parent: Element, include_media: bool) -> None:
        file_el = SubElement(parent, "file", id="file-1")
        SubElement(file_el, "name").text = os.path.basename(video_path)
        SubElement(file_el, "pathurl").text = path_url
        SubElement(file_el, "duration").text = str(total_source_frames)
        add_rate(file_el)
        if include_media:
            file_media = SubElement(file_el, "media")
            file_video = SubElement(file_media, "video")
            file_video_format = SubElement(file_video, "format")
            add_sample_characteristics(file_video_format)
            if has_audio:
                file_audio = SubElement(file_media, "audio")
                SubElement(file_audio, "channelcount").text = str(max(1, audio_channels))

    timeline_offset = 0
    for index, segment in enumerate(keep_segments, start=1):
        src_start = to_frames(segment.start)
        src_end = to_frames(segment.end)
        src_duration = to_frames(segment.duration)
        timeline_start = timeline_offset
        timeline_end = timeline_offset + src_duration

        video_clip = SubElement(video_track, "clipitem", id=f"clipitem-v{index}")
        SubElement(video_clip, "name").text = os.path.basename(video_path)
        SubElement(video_clip, "duration").text = str(total_source_frames)
        add_rate(video_clip)
        SubElement(video_clip, "start").text = str(timeline_start)
        SubElement(video_clip, "end").text = str(timeline_end)
        SubElement(video_clip, "in").text = str(src_start)
        SubElement(video_clip, "out").text = str(src_end)
        add_file_element(video_clip, include_media=(index == 1))

        if has_audio and audio_track is not None:
            audio_clip = SubElement(audio_track, "clipitem", id=f"clipitem-a{index}")
            SubElement(audio_clip, "name").text = os.path.basename(video_path)
            SubElement(audio_clip, "duration").text = str(total_source_frames)
            add_rate(audio_clip)
            SubElement(audio_clip, "start").text = str(timeline_start)
            SubElement(audio_clip, "end").text = str(timeline_end)
            SubElement(audio_clip, "in").text = str(src_start)
            SubElement(audio_clip, "out").text = str(src_end)
            SubElement(audio_clip, "file", id="file-1")
            source_track = SubElement(audio_clip, "sourcetrack")
            SubElement(source_track, "mediatype").text = "audio"
            SubElement(source_track, "trackindex").text = "1"

        timeline_offset = timeline_end

    xml_str = minidom.parseString(tostring(root, encoding="unicode")).toprettyxml(indent="  ")
    xml_str = "\n".join(line for line in xml_str.split("\n") if line.strip())
    with open(output_path, "w", encoding="utf-8") as file_obj:
        file_obj.write(xml_str)
    return output_path


def cut_video(video_path: str, keep_segments: list[Segment], output_path: str) -> str:
    list_path = output_path + ".segments.txt"
    with open(list_path, "w", encoding="utf-8") as file_obj:
        for segment in keep_segments:
            file_obj.write(f"file '{os.path.abspath(video_path)}'\n")
            file_obj.write(f"inpoint {segment.start:.6f}\n")
            file_obj.write(f"outpoint {segment.end:.6f}\n")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

    try:
        os.remove(list_path)
    except OSError:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg error:\n{result.stderr}")
    return output_path


def choose_defaults(mode: str, aggressiveness: str, padding: float | None) -> dict[str, float]:
    defaults = AGGRESSIVENESS_PRESETS[aggressiveness]
    selected_padding = padding if padding is not None else defaults["padding"]
    return {
        "padding": selected_padding,
        "repeat_gap": defaults["repeat_gap"],
        "filler_max_duration": defaults["filler_max_duration"],
        "mode": mode,
    }


def detect_speech_cleanup_segments(
    video_path: str,
    language: str,
    speech_model: str,
    filler_words: str,
    repeat_gap: float,
    filler_max_duration: float,
) -> tuple[list[Segment], dict[str, Any]]:
    print("  Transcribing speech with word timestamps...")
    words, detected_language = transcribe_words(video_path, speech_model, language)
    if not words:
        raise RuntimeError("No word timestamps were produced; transcription could not continue.")

    single_fillers, phrase_fillers = parse_filler_inputs(filler_words)
    filler_segments = detect_filler_segments(
        words,
        single_fillers,
        phrase_fillers,
        filler_max_duration,
    )
    repeat_word_segments = detect_repeated_words(words, repeat_gap)
    repeat_phrase_segments = detect_repeated_phrases(words, repeat_gap)

    segments = merge_segments(
        filler_segments + repeat_word_segments + repeat_phrase_segments,
        bridge_gap=0.03,
    )
    return segments, {
        "transcript_words": len(words),
        "detected_language": detected_language or language,
        "filler_hits": len(filler_segments),
        "repeat_word_hits": len(repeat_word_segments),
        "repeat_phrase_hits": len(repeat_phrase_segments),
    }


def print_report(
    video_path: str,
    mode: str,
    remove_segments: list[Segment],
    keep_segments: list[Segment],
    total_duration: float,
    threshold: float | None,
    min_silence: float | None,
    speech_stats: dict[str, Any] | None,
) -> None:
    total_cut = sum(segment.duration for segment in remove_segments)
    total_kept = sum(segment.duration for segment in keep_segments)
    pct_cut = (total_cut / total_duration) * 100 if total_duration > 0 else 0
    reason_counts = Counter(segment.reason for segment in remove_segments)

    print("\n" + "=" * 52)
    print("  SILENCE CUTTER - REPORT")
    print("=" * 52)
    print(f"  Input:          {os.path.basename(video_path)}")
    print(f"  Mode:           {mode}")
    print(f"  Duration:       {total_duration:.1f}s")
    if threshold is not None:
        print(f"  Threshold:      {threshold:.1f} dB")
    if min_silence is not None:
        print(f"  Min silence:    {min_silence:.2f}s")
    if speech_stats:
        print(f"  Transcript:     {speech_stats['transcript_words']} words")
        print(f"  Language:       {speech_stats['detected_language']}")
    print(f"  Segments found: {len(remove_segments)}")
    print(f"  Total cut:      {total_cut:.1f}s ({pct_cut:.1f}%)")
    print(f"  Output length:  {total_kept:.1f}s")
    if reason_counts:
        breakdown = ", ".join(f"{reason}={count}" for reason, count in sorted(reason_counts.items()))
        print(f"  Breakdown:      {breakdown}")
    print("-" * 52)

    preview = remove_segments if len(remove_segments) <= 8 else remove_segments[:5]
    for index, segment in enumerate(preview, start=1):
        print(
            f"  Cut {index:02d}:  {segment.start:7.2f}s -> {segment.end:7.2f}s"
            f"  ({segment.duration:.2f}s) [{segment.reason}]"
        )
    if len(remove_segments) > len(preview):
        print(f"  ... and {len(remove_segments) - len(preview)} more cuts ...")
    print("=" * 52)


def build_output_basename(video_path: str, mode: str) -> str:
    base_name = os.path.splitext(os.path.basename(video_path))[0]
    if mode == "silence":
        return base_name
    return f"{base_name}_{mode.replace('-', '_')}"


def segment_to_dict(segment: Segment) -> dict[str, Any]:
    return {
        "start": round(segment.start, 6),
        "end": round(segment.end, 6),
        "duration": round(segment.duration, 6),
        "reason": segment.reason,
        "label": segment.label,
    }


def run(
    video_path: str,
    output_dir: str | None = None,
    threshold: float | None = None,
    min_silence: float | None = None,
    padding: float | None = None,
    export_xml: bool = True,
    export_mp4: bool = True,
    mode: str = "silence",
    language: str = "en",
    speech_model: str = "base",
    filler_words: str | None = None,
    aggressiveness: str = "medium",
    repeat_gap: float | None = None,
    filler_max_duration: float | None = None,
    include_markers: bool = True,
    include_plan: bool = False,
) -> dict[str, Any]:
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    defaults = choose_defaults(mode, aggressiveness, padding)
    padding = defaults["padding"]
    repeat_gap = repeat_gap if repeat_gap is not None else defaults["repeat_gap"]
    filler_max_duration = (
        filler_max_duration
        if filler_max_duration is not None
        else defaults["filler_max_duration"]
    )
    filler_words = filler_words or ",".join(DEFAULT_FILLERS + DEFAULT_FILLER_PHRASES)

    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(video_path))
    os.makedirs(output_dir, exist_ok=True)

    media_props = get_media_properties(video_path)
    if not media_props["has_audio"]:
        raise RuntimeError("Video has no audio stream; cleanup requires an audio track.")

    print(f"\nAnalyzing: {os.path.basename(video_path)}")
    total_duration = media_props["duration"]
    fps = media_props["fps"]
    print(
        f"  Duration: {total_duration:.1f}s @ {fps:.2f}fps"
        f" ({media_props['width']}x{media_props['height']})"
    )
    print(f"  Mode: {mode}")

    removal_segments: list[Segment] = []
    speech_stats: dict[str, Any] | None = None

    if mode in ("speech-clean", "hybrid"):
        speech_segments, speech_stats = detect_speech_cleanup_segments(
            video_path=video_path,
            language=language,
            speech_model=speech_model,
            filler_words=filler_words,
            repeat_gap=repeat_gap,
            filler_max_duration=filler_max_duration,
        )
        print(f"  Speech cleanup hits: {len(speech_segments)}")
        removal_segments.extend(speech_segments)

    if mode in ("silence", "hybrid"):
        if threshold is None or min_silence is None:
            print("  Auto-detecting silence parameters...")
            auto_threshold, auto_min_silence = auto_detect_threshold(video_path)
            if threshold is None:
                threshold = auto_threshold
            if min_silence is None:
                min_silence = auto_min_silence
        print("  Detecting silence...")
        silence_segments = detect_silence(video_path, threshold, min_silence)
        print(f"  Silence hits: {len(silence_segments)}")
        removal_segments.extend(silence_segments)

    removal_segments = merge_segments(removal_segments, bridge_gap=0.04, total_duration=total_duration)
    keep_segments, cut_markers = removals_to_keep_segments(removal_segments, total_duration, padding)

    print_report(
        video_path=video_path,
        mode=mode,
        remove_segments=removal_segments,
        keep_segments=keep_segments,
        total_duration=total_duration,
        threshold=threshold if mode in ("silence", "hybrid") else None,
        min_silence=min_silence if mode in ("silence", "hybrid") else None,
        speech_stats=speech_stats,
    )

    outputs: dict[str, Any] = {}
    output_base = build_output_basename(video_path, mode)

    if export_xml:
        xml_path = os.path.join(output_dir, f"{output_base}_timeline.xml")
        print("\n  Generating Premiere XML...")
        generate_premiere_xml(
            keep_segments=keep_segments,
            cut_markers=cut_markers,
            video_path=video_path,
            total_duration=total_duration,
            fps=fps,
            width=media_props["width"],
            height=media_props["height"],
            has_audio=media_props["has_audio"],
            audio_channels=media_props["audio_channels"],
            output_path=xml_path,
            include_markers=include_markers,
        )
        print(f"  XML saved: {xml_path}")
        outputs["xml"] = xml_path

    if export_mp4:
        mp4_path = os.path.join(output_dir, f"{output_base}_cut.mp4")
        print("\n  Cutting video (stream copy, no re-encode)...")
        cut_video(video_path, keep_segments, mp4_path)
        print(f"  MP4 saved: {mp4_path}")
        outputs["mp4"] = mp4_path

    time_cut = sum(segment.duration for segment in removal_segments)
    outputs["stats"] = {
        "mode": mode,
        "total_duration": total_duration,
        "cuts": len(removal_segments),
        "time_cut": time_cut,
        "time_saved_pct": round((time_cut / total_duration) * 100, 1) if total_duration else 0.0,
        "threshold_db": threshold,
        "min_silence_s": min_silence,
        "keep_segments": len(keep_segments),
        "markers": len(cut_markers),
        "reason_counts": dict(Counter(segment.reason for segment in removal_segments)),
        "speech": speech_stats or {},
    }
    if include_plan:
        outputs["plan"] = {
            "mode": mode,
            "video_path": os.path.abspath(video_path),
            "total_duration": round(total_duration, 6),
            "keep_segments": [segment_to_dict(segment) for segment in keep_segments],
            "remove_segments": [segment_to_dict(segment) for segment in removal_segments],
            "markers": (
                [
                    {
                        "timeline": round(marker["timeline"], 6),
                        "source_start": round(marker["source_start"], 6),
                        "source_end": round(marker["source_end"], 6),
                        "reason": marker["reason"],
                        "label": marker["label"],
                    }
                    for marker in cut_markers
                ]
                if include_markers else []
            ),
            "stats": outputs["stats"],
        }
    return outputs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cut silence or clean spoken filler/repetitions from a video",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python silence_cutter.py video.mp4 --mode silence
  python silence_cutter.py video.mp4 --mode speech-clean --xml-only
  python silence_cutter.py video.mp4 --mode hybrid --aggressiveness low
  python silence_cutter.py video.mp4 --mode hybrid --speech-model small --language en
        """,
    )
    parser.add_argument("video", help="Input video file path")
    parser.add_argument("--mode", choices=["silence", "speech-clean", "hybrid"], default="silence",
        help="silence: dead air only, speech-clean: fillers/repetitions only, hybrid: both")
    parser.add_argument("--threshold", type=float, default=None,
        help="Silence threshold in dB. Auto-detected if omitted.")
    parser.add_argument("--min-silence", type=float, default=None,
        help="Minimum silence duration in seconds. Auto-detected if omitted.")
    parser.add_argument("--padding", type=float, default=None,
        help="Handle padding around cuts. Defaults depend on aggressiveness.")
    parser.add_argument("--output-dir", default=None,
        help="Output directory (default: same as input)")
    parser.add_argument("--xml-only", action="store_true",
        help="Only generate Premiere XML, skip MP4")
    parser.add_argument("--mp4-only", action="store_true",
        help="Only generate cut MP4, skip XML")
    parser.add_argument("--language", default="en",
        help="Transcription language for speech-clean/hybrid. Use 'auto' to auto-detect.")
    parser.add_argument("--speech-model", default="base",
        help="faster-whisper model name for speech-clean/hybrid (tiny, base, small, medium, large-v3)")
    parser.add_argument("--filler-words", default=",".join(DEFAULT_FILLERS + DEFAULT_FILLER_PHRASES),
        help="Comma-separated filler words/phrases to remove")
    parser.add_argument("--aggressiveness", choices=["low", "medium", "high"], default="medium",
        help="Controls repeat gap, filler duration, and default padding")
    parser.add_argument("--repeat-gap", type=float, default=None,
        help="Max gap between repeated words/phrases to treat as a repetition")
    parser.add_argument("--filler-max-duration", type=float, default=None,
        help="Ignore filler words longer than this many seconds")
    parser.add_argument("--no-markers", action="store_true",
        help="Do not add cut markers to the Premiere XML timeline")
    parser.add_argument("--plan-only", action="store_true",
        help="Analyze and emit a cut plan without creating XML or MP4 files")
    parser.add_argument("--emit-plan", action="store_true",
        help="Print a machine-readable PLAN_JSON line after completion")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    export_xml = not args.mp4_only and not args.plan_only
    export_mp4 = not args.xml_only and not args.plan_only

    try:
        outputs = run(
            video_path=args.video,
            output_dir=args.output_dir,
            threshold=args.threshold,
            min_silence=args.min_silence,
            padding=args.padding,
            export_xml=export_xml,
            export_mp4=export_mp4,
            mode=args.mode,
            language=args.language,
            speech_model=args.speech_model,
            filler_words=args.filler_words,
            aggressiveness=args.aggressiveness,
            repeat_gap=args.repeat_gap,
            filler_max_duration=args.filler_max_duration,
            include_markers=not args.no_markers,
            include_plan=args.emit_plan or args.plan_only,
        )
        if args.emit_plan and outputs.get("plan"):
            print(f"PLAN_JSON:{json.dumps(outputs['plan'], ensure_ascii=False)}")
        print("\nDone.\n")
        return 0
    except Exception as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
