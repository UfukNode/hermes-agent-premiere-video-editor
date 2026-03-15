function hermes_escapeResult(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value);
}

function hermes_collectionLength(collection) {
    if (!collection) {
        return 0;
    }
    if (typeof collection.numItems === "number") {
        return collection.numItems;
    }
    if (typeof collection.numTracks === "number") {
        return collection.numTracks;
    }
    if (typeof collection.length === "number") {
        return collection.length;
    }
    return 0;
}

function hermes_collectionItem(collection, index) {
    if (!collection) {
        return null;
    }
    return collection[index] || collection[index + 1] || null;
}

function hermes_findTrackIndex(tracks, targetTrack) {
    var count = hermes_collectionLength(tracks);
    for (var index = 0; index < count; index += 1) {
        var track = hermes_collectionItem(tracks, index);
        if (track === targetTrack) {
            return index;
        }
    }
    return -1;
}

function hermes_findTrackIndexForClip(tracks, mediaPath, clipStart, clipEnd) {
    var trackCount = hermes_collectionLength(tracks);
    for (var trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
        var track = hermes_collectionItem(tracks, trackIndex);
        if (!track || !track.clips) {
            continue;
        }

        var clipCount = hermes_collectionLength(track.clips);
        for (var clipIndex = 0; clipIndex < clipCount; clipIndex += 1) {
            var clip = hermes_collectionItem(track.clips, clipIndex);
            if (!clip || !clip.projectItem) {
                continue;
            }

            var itemPath = hermes_mediaPathFromTrackItem(clip);
            var start = hermes_secondsFromTime(clip.start);
            var end = hermes_secondsFromTime(clip.end);
            if (itemPath === mediaPath && Math.abs(start - clipStart) < 0.05 && Math.abs(end - clipEnd) < 0.05) {
                return trackIndex;
            }
        }
    }
    return -1;
}

function hermes_mediaPathFromTrackItem(trackItem) {
    if (!trackItem || !trackItem.projectItem) {
        return "";
    }
    if (typeof trackItem.projectItem.getMediaPath !== "function") {
        return "";
    }
    return hermes_escapeResult(trackItem.projectItem.getMediaPath());
}

function hermes_secondsFromTime(timeValue) {
    if (!timeValue) {
        return 0;
    }
    if (typeof timeValue.seconds === "number") {
        return timeValue.seconds;
    }
    if (typeof timeValue.seconds === "string") {
        return Number(timeValue.seconds) || 0;
    }
    return 0;
}

function hermes_getSelectedTrackItem(sequence) {
    var selection = sequence.getSelection();
    var selectionCount = hermes_collectionLength(selection);
    if (selection && selectionCount > 0) {
        for (var index = 0; index < selectionCount; index += 1) {
            var selectedItem = hermes_collectionItem(selection, index);
            if (selectedItem && selectedItem.projectItem) {
                return selectedItem;
            }
        }
    }

    var videoTrackCount = hermes_collectionLength(sequence.videoTracks);
    for (var trackIndex = 0; trackIndex < videoTrackCount; trackIndex += 1) {
        var videoTrack = hermes_collectionItem(sequence.videoTracks, trackIndex);
        if (!videoTrack || !videoTrack.clips) {
            continue;
        }
        var clipCount = hermes_collectionLength(videoTrack.clips);
        for (var clipIndex = 0; clipIndex < clipCount; clipIndex += 1) {
            var clip = hermes_collectionItem(videoTrack.clips, clipIndex);
            if (clip && typeof clip.isSelected === "function" && clip.isSelected()) {
                return clip;
            }
        }
    }

    return null;
}

function hermes_getSelectedTrackItems(sequence) {
    var items = [];
    var selection = sequence.getSelection();
    var selectionCount = hermes_collectionLength(selection);

    if (selection && selectionCount > 0) {
        for (var index = 0; index < selectionCount; index += 1) {
            var selectedItem = hermes_collectionItem(selection, index);
            if (selectedItem && selectedItem.projectItem) {
                items.push(selectedItem);
            }
        }
    }

    if (items.length) {
        return items;
    }

    var fallback = hermes_getSelectedTrackItem(sequence);
    if (fallback) {
        items.push(fallback);
    }
    return items;
}

function hermes_findSelectedTrackMediaPath(sequence, tracks) {
    var trackCount = hermes_collectionLength(tracks);
    for (var trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
        var track = hermes_collectionItem(tracks, trackIndex);
        if (!track || !track.clips) {
            continue;
        }

        var clipCount = hermes_collectionLength(track.clips);
        for (var clipIndex = 0; clipIndex < clipCount; clipIndex += 1) {
            var clip = hermes_collectionItem(track.clips, clipIndex);
            if (!clip || typeof clip.isSelected !== "function") {
                continue;
            }

            if (clip.isSelected()) {
                var mediaPath = hermes_mediaPathFromTrackItem(clip);
                if (mediaPath) {
                    return mediaPath;
                }
            }
        }
    }
    return "";
}

function hermes_getSelectedMediaPath() {
    try {
        if (!app || !app.project) {
            return "ERROR: Premiere project is not available.";
        }

        var sequence = app.project.activeSequence;
        if (!sequence) {
            return "NO_SELECTION";
        }

        var selection = sequence.getSelection();
        var selectionCount = hermes_collectionLength(selection);
        if (selection && selectionCount > 0) {
            for (var index = 0; index < selectionCount; index += 1) {
                var selectedItem = hermes_collectionItem(selection, index);
                var selectedMediaPath = hermes_mediaPathFromTrackItem(selectedItem);
                if (selectedMediaPath) {
                    return selectedMediaPath;
                }
            }
        }

        var videoSelectionPath = hermes_findSelectedTrackMediaPath(sequence, sequence.videoTracks);
        if (videoSelectionPath) {
            return videoSelectionPath;
        }

        var audioSelectionPath = hermes_findSelectedTrackMediaPath(sequence, sequence.audioTracks);
        if (audioSelectionPath) {
            return audioSelectionPath;
        }

        return "NO_SELECTION";
    } catch (error) {
        return "ERROR: " + error.toString();
    }
}

function hermes_getSelectedClipContext() {
    try {
        if (!app || !app.project) {
            return "ERROR: Premiere project is not available.";
        }

        var sequence = app.project.activeSequence;
        if (!sequence) {
            return "NO_SELECTION";
        }

        var trackItem = hermes_getSelectedTrackItem(sequence);
        var mediaPath = hermes_mediaPathFromTrackItem(trackItem);
        if (!trackItem || !mediaPath) {
            return "NO_SELECTION";
        }

        var videoTrackIndex = -1;
        var audioTrackIndex = -1;
        var selectedItems = hermes_getSelectedTrackItems(sequence);
        for (var index = 0; index < selectedItems.length; index += 1) {
            var item = selectedItems[index];
            if (item && item.mediaType === "Video" && videoTrackIndex < 0) {
                videoTrackIndex = hermes_findTrackIndex(sequence.videoTracks, item.parentTrack);
            }
            if (item && item.mediaType === "Audio" && audioTrackIndex < 0) {
                audioTrackIndex = hermes_findTrackIndex(sequence.audioTracks, item.parentTrack);
            }
        }

        if (videoTrackIndex < 0 && trackItem.mediaType === "Video") {
            videoTrackIndex = hermes_findTrackIndex(sequence.videoTracks, trackItem.parentTrack);
        }
        if (audioTrackIndex < 0 && trackItem.mediaType === "Audio") {
            audioTrackIndex = hermes_findTrackIndex(sequence.audioTracks, trackItem.parentTrack);
        }
        if (videoTrackIndex < 0) {
            videoTrackIndex = hermes_findTrackIndexForClip(
                sequence.videoTracks,
                mediaPath,
                hermes_secondsFromTime(trackItem.start),
                hermes_secondsFromTime(trackItem.end)
            );
        }
        if (audioTrackIndex < 0) {
            audioTrackIndex = hermes_findTrackIndexForClip(
                sequence.audioTracks,
                mediaPath,
                hermes_secondsFromTime(trackItem.start),
                hermes_secondsFromTime(trackItem.end)
            );
        }

        var payload = {
            clipName: trackItem.name || trackItem.projectItem.name || "Selected Clip",
            mediaPath: mediaPath,
            sourceIn: hermes_secondsFromTime(trackItem.inPoint),
            sourceOut: hermes_secondsFromTime(trackItem.outPoint),
            clipStart: hermes_secondsFromTime(trackItem.start),
            clipEnd: hermes_secondsFromTime(trackItem.end),
            videoTrackIndex: videoTrackIndex,
            audioTrackIndex: audioTrackIndex
        };

        return hermes_escapeResult(JSON.stringify(payload));
    } catch (error) {
        return "ERROR: " + error.toString();
    }
}

function hermes_getSelectionDebug() {
    try {
        if (!app || !app.project || !app.project.activeSequence) {
            return "NO_ACTIVE_SEQUENCE";
        }

        var sequence = app.project.activeSequence;
        var selection = sequence.getSelection();
        var selectionCount = hermes_collectionLength(selection);
        var videoTrackCount = hermes_collectionLength(sequence.videoTracks);
        var audioTrackCount = hermes_collectionLength(sequence.audioTracks);

        return hermes_escapeResult(
            "selectionCount=" + selectionCount +
            "; videoTracks=" + videoTrackCount +
            "; audioTracks=" + audioTrackCount
        );
    } catch (error) {
        return "ERROR: " + error.toString();
    }
}

function hermes_ticksFromSeconds(seconds) {
    var value = Math.max(0, Number(seconds) || 0);
    return String(Math.round(value * 254016000000));
}

function hermes_createSequenceMarker(markerCollection, marker) {
    if (!markerCollection || typeof markerCollection.createMarker !== "function") {
        return;
    }

    var markerObject = markerCollection.createMarker(hermes_secondsFromTime({ seconds: marker.timeline }));
    if (!markerObject) {
        return;
    }

    markerObject.name = marker.label || marker.reason || "HERMES cut";
    markerObject.comments = (marker.reason || "cut") + " | source " +
        Number(marker.source_start || 0).toFixed(2) + "s-" +
        Number(marker.source_end || 0).toFixed(2) + "s";
}

function hermes_intersectKeepSegments(keepSegments, selection) {
    var sourceIn = Math.max(0, Number(selection.sourceIn) || 0);
    var sourceOut = Math.max(sourceIn, Number(selection.sourceOut) || sourceIn);
    var segments = [];

    for (var index = 0; index < keepSegments.length; index += 1) {
        var keep = keepSegments[index];
        var start = Math.max(sourceIn, Number(keep.start) || 0);
        var end = Math.min(sourceOut, Number(keep.end) || 0);
        if (end - start > 0.01) {
            segments.push({
                start: start,
                end: end,
                duration: end - start
            });
        }
    }

    if (!segments.length && sourceOut - sourceIn > 0.01) {
        segments.push({
            start: sourceIn,
            end: sourceOut,
            duration: sourceOut - sourceIn
        });
    }

    return segments;
}

function hermes_collectReplacementSelection(sequence, selectionContext) {
    var items = hermes_getSelectedTrackItems(sequence);
    var mediaPath = selectionContext.mediaPath;
    var clipStart = Number(selectionContext.clipStart) || 0;
    var clipEnd = Number(selectionContext.clipEnd) || clipStart;
    var matches = [];

    for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (!item || !item.projectItem) {
            continue;
        }

        var itemPath = hermes_mediaPathFromTrackItem(item);
        var start = hermes_secondsFromTime(item.start);
        var end = hermes_secondsFromTime(item.end);
        if (itemPath === mediaPath && Math.abs(start - clipStart) < 0.05 && Math.abs(end - clipEnd) < 0.05) {
            matches.push(item);
        }
    }

    if (matches.length) {
        return matches;
    }

    var primary = hermes_getSelectedTrackItem(sequence);
    return primary ? [primary] : [];
}

function hermes_findAllMatchingTrackItems(sequence, selectionContext) {
    var matches = [];
    var mediaPath = selectionContext.mediaPath;
    var clipStart = Number(selectionContext.clipStart) || 0;
    var clipEnd = Number(selectionContext.clipEnd) || clipStart;

    function collectFromTracks(tracks) {
        var trackCount = hermes_collectionLength(tracks);
        for (var trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
            var track = hermes_collectionItem(tracks, trackIndex);
            if (!track || !track.clips) {
                continue;
            }

            var clipCount = hermes_collectionLength(track.clips);
            for (var clipIndex = 0; clipIndex < clipCount; clipIndex += 1) {
                var clip = hermes_collectionItem(track.clips, clipIndex);
                if (!clip || !clip.projectItem) {
                    continue;
                }

                var itemPath = hermes_mediaPathFromTrackItem(clip);
                var start = hermes_secondsFromTime(clip.start);
                var end = hermes_secondsFromTime(clip.end);
                if (itemPath === mediaPath && Math.abs(start - clipStart) < 0.05 && Math.abs(end - clipEnd) < 0.05) {
                    matches.push(clip);
                }
            }
        }
    }

    collectFromTracks(sequence.videoTracks);
    collectFromTracks(sequence.audioTracks);
    return matches;
}

function hermes_applyCleanupPlanToSelection(payloadJson) {
    try {
        if (!app || !app.project || !app.project.activeSequence) {
            return "ERROR: No active Premiere sequence is available.";
        }

        var payload = JSON.parse(payloadJson);
        var plan = payload.plan;
        var selectionContext = payload.selection;
        if (!plan || !selectionContext || !selectionContext.mediaPath) {
            return "ERROR: Invalid cleanup payload.";
        }

        var sequence = app.project.activeSequence;
        var selectedItems = hermes_collectReplacementSelection(sequence, selectionContext);
        var trackItem = selectedItems.length ? selectedItems[0] : null;
        if (!trackItem || !trackItem.projectItem) {
            return "ERROR: Reselect the source clip before applying cleanup.";
        }

        var projectItem = trackItem.projectItem;
        var mediaPath = hermes_mediaPathFromTrackItem(trackItem);
        if (mediaPath !== selectionContext.mediaPath) {
            return "ERROR: Selected clip changed during analysis. Reselect the same clip and run again.";
        }

        var keepSegments = hermes_intersectKeepSegments(plan.keep_segments || [], selectionContext);
        if (!keepSegments.length) {
            return "ERROR: Cleanup plan produced no usable kept segments.";
        }
        var insertionTime = Number(selectionContext.clipStart) || 0;
        var videoTrackIndex = Number(selectionContext.videoTrackIndex);
        var audioTrackIndex = Number(selectionContext.audioTrackIndex);
        if (videoTrackIndex < 0) {
            videoTrackIndex = hermes_findTrackIndexForClip(
                sequence.videoTracks,
                selectionContext.mediaPath,
                Number(selectionContext.clipStart) || 0,
                Number(selectionContext.clipEnd) || Number(selectionContext.clipStart) || 0
            );
        }
        if (audioTrackIndex < 0) {
            audioTrackIndex = hermes_findTrackIndexForClip(
                sequence.audioTracks,
                selectionContext.mediaPath,
                Number(selectionContext.clipStart) || 0,
                Number(selectionContext.clipEnd) || Number(selectionContext.clipStart) || 0
            );
        }
        if (videoTrackIndex < 0 && audioTrackIndex < 0) {
            return "ERROR: Could not determine the selected clip track. Select both video/audio parts or reselect the clip body.";
        }

        var matchedTrackItems = hermes_findAllMatchingTrackItems(sequence, selectionContext);
        if (!matchedTrackItems.length) {
            matchedTrackItems = [trackItem];
        }

        for (var removeIndex = 0; removeIndex < matchedTrackItems.length; removeIndex += 1) {
            matchedTrackItems[removeIndex].setSelected(1, 0);
        }
        for (var deleteIndex = 0; deleteIndex < matchedTrackItems.length; deleteIndex += 1) {
            matchedTrackItems[deleteIndex].remove(0, 0);
        }

        for (var index = 0; index < keepSegments.length; index += 1) {
            var segment = keepSegments[index];
            var startTicks = hermes_ticksFromSeconds(segment.start);
            var endTicks = hermes_ticksFromSeconds(segment.end);
            var subclipName = (selectionContext.clipName || projectItem.name || "Clip") + " [HERMES " + (index + 1) + "]";
            var subclip = projectItem.createSubClip(
                subclipName,
                startTicks,
                endTicks,
                0,
                1,
                1
            );
            if (!subclip) {
                return "ERROR: Premiere could not create subclips for the selected clip.";
            }

            sequence.insertClip(
                subclip,
                hermes_ticksFromSeconds(insertionTime),
                videoTrackIndex >= 0 ? videoTrackIndex : 0,
                audioTrackIndex >= 0 ? audioTrackIndex : 0
            );
            insertionTime += Number(segment.duration) || 0;
        }

        if (sequence.markers && plan.markers) {
            for (var markerIndex = 0; markerIndex < plan.markers.length; markerIndex += 1) {
                var marker = plan.markers[markerIndex];
                marker.timeline = (Number(selectionContext.clipStart) || 0) + (Number(marker.timeline) || 0);
                hermes_createSequenceMarker(sequence.markers, marker);
            }
        }

        return "Applied HERMES cleanup on the active Premiere sequence.";
    } catch (error) {
        return "ERROR: " + error.toString();
    }
}
