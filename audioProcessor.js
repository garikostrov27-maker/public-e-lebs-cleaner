/*
  Dynamic Speech Trimmer – processing helpers

  Tweak these options to change behavior:
  - silenceThreshold (higher = more aggressive, lower = more sensitive)
  - minSilenceMs    (higher = only long pauses get cut)
  - overlapMs       (higher = smoother transitions, slightly less compression)
*/

(function () {
  const DEFAULTS = {
    silenceThreshold: 0.015,
    minSilenceMs: 200,
    overlapMs: 60,
  };

  /**
   * Main entry point: trims long silences and returns a WAV Blob (mono, 16-bit PCM).
   * @param {AudioContext} audioContext
   * @param {AudioBuffer} audioBuffer
   * @param {{silenceThreshold?: number, minSilenceMs?: number, overlapMs?: number}} options
   * @returns {Promise<Blob>} WAV blob of processed audio
   */
  async function processAudioBuffer(audioContext, audioBuffer, options = {}) {
    const silenceThreshold = options.silenceThreshold ?? DEFAULTS.silenceThreshold;
    const minSilenceMs = options.minSilenceMs ?? DEFAULTS.minSilenceMs;
    const overlapMs = options.overlapMs ?? DEFAULTS.overlapMs;

    const sampleRate = audioBuffer.sampleRate;
    const minSilenceSamples = msToSamples(minSilenceMs, sampleRate);
    const overlapSamples = msToSamples(overlapMs, sampleRate);

    // Downmix to mono if needed by averaging all channels
    const monoData = downmixToMono(audioBuffer);

    // Detect speech segments separated by long silence
    const segments = detectSpeechSegments(
      monoData,
      sampleRate,
      silenceThreshold,
      minSilenceSamples
    );

    // If no significant silence found, return original as WAV
    if (segments.length <= 1 && segments[0] && segments[0][0] === 0 && segments[0][1] === monoData.length) {
      const originalBuffer = audioContext.createBuffer(1, monoData.length, sampleRate);
      originalBuffer.copyToChannel(monoData, 0);
      return audioBufferToWavBlob(originalBuffer);
    }

    // Rebuild the output with crossfades between segments
    const stitchedData = buildOutputBufferFromSegments(monoData, segments, overlapSamples);

    const outBuffer = audioContext.createBuffer(1, stitchedData.length, sampleRate);
    outBuffer.copyToChannel(stitchedData, 0);

    return audioBufferToWavBlob(outBuffer);
  }

  /**
   * Convert milliseconds to samples at a given sample rate.
   */
  function msToSamples(ms, sampleRate) {
    return Math.max(0, Math.round((ms / 1000) * sampleRate));
  }

  /**
   * Downmix multi-channel AudioBuffer to a mono Float32Array by averaging channels.
   */
  function downmixToMono(audioBuffer) {
    const { numberOfChannels } = audioBuffer;
    const length = audioBuffer.length;
    if (numberOfChannels === 1) {
      // Copy so we do not keep reference to internal buffer
      const mono = new Float32Array(length);
      audioBuffer.copyFromChannel(mono, 0);
      return mono;
    }

    const sum = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = new Float32Array(length);
      audioBuffer.copyFromChannel(channelData, ch);
      for (let i = 0; i < length; i++) {
        sum[i] += channelData[i];
      }
    }
    for (let i = 0; i < length; i++) sum[i] /= numberOfChannels;
    return sum;
  }

  /**
   * Detect speech segments based on amplitude threshold and minimal silence duration.
   * Returns array of [startSample, endSample] in original buffer indices.
   */
  function detectSpeechSegments(channelData, sampleRate, silenceThreshold, minSilenceSamples) {
    const N = channelData.length;
    const segments = [];

    let inSilence = false;
    let silenceRun = 0;
    let currentSpeechStart = 0;

    for (let i = 0; i < N; i++) {
      const amp = Math.abs(channelData[i]);
      if (amp < silenceThreshold) {
        silenceRun++;
        if (!inSilence && silenceRun >= minSilenceSamples) {
          // Silence long enough to split: close speech before the silence began
          const speechEnd = Math.max(0, i - silenceRun);
          if (speechEnd > currentSpeechStart) {
            segments.push([currentSpeechStart, speechEnd]);
          }
          inSilence = true;
        }
      } else {
        // Non-silent sample resets silence
        if (inSilence) {
          // We just exited a long-silence region; mark new speech start at current i
          currentSpeechStart = i;
        }
        inSilence = false;
        silenceRun = 0;
      }
    }

    // Tail handling: if we ended during speech, close final segment
    if (!inSilence && currentSpeechStart < N) {
      segments.push([currentSpeechStart, N]);
    }

    // If nothing found, treat entire clip as one speech segment
    if (segments.length === 0) {
      segments.push([0, N]);
    }

    // Merge tiny segments that may occur due to threshold flicker
    const MERGE_GAP_SAMPLES = Math.floor(sampleRate * 0.03); // 30 ms
    const merged = [];
    for (const seg of segments) {
      if (merged.length === 0) {
        merged.push(seg);
      } else {
        const prev = merged[merged.length - 1];
        if (seg[0] - prev[1] <= MERGE_GAP_SAMPLES) {
          prev[1] = seg[1];
        } else {
          merged.push(seg);
        }
      }
    }

    return merged;
  }

  /**
   * Stitch segments together with crossfade overlap.
   * Returns a new Float32Array of the stitched mono samples.
   */
  function buildOutputBufferFromSegments(source, segments, overlapSamples) {
    if (segments.length === 0) return new Float32Array(0);
    if (segments.length === 1) {
      const [s, e] = segments[0];
      return source.subarray(s, e).slice();
    }

    // Compute total length with overlaps
    let total = 0;
    for (let idx = 0; idx < segments.length; idx++) {
      const [s, e] = segments[idx];
      const len = e - s;
      total += len;
      if (idx > 0) {
        const prevLen = segments[idx - 1][1] - segments[idx - 1][0];
        const ov = Math.min(overlapSamples, prevLen, len);
        total -= ov; // overlap replaces last ov samples of previous + first ov of current with crossfade
      }
    }

    const out = new Float32Array(total);
    let writePos = 0;

    for (let idx = 0; idx < segments.length; idx++) {
      const [s, e] = segments[idx];
      const segLen = e - s;
      const segView = source.subarray(s, e);

      if (idx === 0) {
        // First segment: copy as-is (we'll crossfade when the next appends)
        out.set(segView, writePos);
        writePos += segLen;
      } else {
        const [ps, pe] = segments[idx - 1];
        const prevLen = pe - ps;
        const ov = Math.min(overlapSamples, prevLen, segLen);

        // Adjust write position to make room for crossfade replacing overlap
        writePos -= ov;

        // Copy non-overlapped start of current segment after crossfade
        // But first, do the crossfade over 'ov' samples
        for (let i = 0; i < ov; i++) {
          const a = out[writePos + i]; // tail of previous already in output
          const b = segView[i]; // head of current
          const fadeIn = ov === 0 ? 1 : i / ov;
          const fadeOut = 1 - fadeIn;
          out[writePos + i] = a * fadeOut + b * fadeIn;
        }

        // Then copy the remainder of the current segment after the overlapped part
        out.set(segView.subarray(ov), writePos + ov);
        writePos += segLen; // net advance: segLen - ov was already subtracted via writePos -= ov earlier
      }
    }

    return out;
  }

  /**
   * Encode an AudioBuffer (mono) to a WAV Blob (16-bit PCM).
   */
  function audioBufferToWavBlob(buffer) {
    const numChannels = 1;
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);
    const samples = channelData.length;

    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples * bytesPerSample;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const bufferArray = new ArrayBuffer(totalSize);
    const view = new DataView(bufferArray);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // audio format: PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // PCM samples
    floatTo16BitPCM(view, 44, channelData);

    return new Blob([view], { type: 'audio/wav' });
  }

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  function floatTo16BitPCM(view, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      // Clamp to [-1, 1] and scale
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  // Expose helpers if needed elsewhere
  window.processAudioBuffer = processAudioBuffer;
  window._speechTrimmer = {
    msToSamples,
    detectSpeechSegments,
    buildOutputBufferFromSegments,
    audioBufferToWavBlob,
  };
})();


