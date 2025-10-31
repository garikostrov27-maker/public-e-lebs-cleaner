(function () {
  const fileInput = document.getElementById('fileInput');
  const processBtn = document.getElementById('processBtn');
  const originalAudio = document.getElementById('originalAudio');
  const processedAudio = document.getElementById('processedAudio');
  const downloadLink = document.getElementById('downloadLink');
  const toast = document.getElementById('toast');
  const silenceThresholdInput = document.getElementById('silenceThreshold');
  const silenceThresholdValue = document.getElementById('silenceThresholdValue');
  const minSilenceMsInput = document.getElementById('minSilenceMs');
  const minSilenceMsValue = document.getElementById('minSilenceMsValue');
  const overlapMsInput = document.getElementById('overlapMs');
  const overlapMsValue = document.getElementById('overlapMsValue');
  const enableEq = document.getElementById('enableEq');
  const eqPreset = document.getElementById('eqPreset');
  const eqCustomGroup = document.getElementById('eqCustomGroup');
  const eqLow = document.getElementById('eqLow');
  const eqLowValue = document.getElementById('eqLowValue');
  const eqMid = document.getElementById('eqMid');
  const eqMidValue = document.getElementById('eqMidValue');
  const eqHigh = document.getElementById('eqHigh');
  const eqHighValue = document.getElementById('eqHighValue');

  let selectedFile = null;
  let audioContext = null;

  const PROCESS_OPTIONS = {
    silenceThreshold: 0.015,
    minSilenceMs: 250,
    overlapMs: 70,
  };

  // EQ state (gains in dB)
  const EQ_STATE = {
    enabled: false,
    mode: 'clear', // 'clear' | 'warm' | 'cinematic' | 'custom'
    lowDb: 0,
    midDb: 0,
    highDb: 0,
  };

  // Initialize controls from defaults

  // Initialize sliders from defaults and bind live updates
  applyOptionsToControls(PROCESS_OPTIONS);
  bindControlUpdates();
  initEqUI();

  // Initialize enhanced audio players (Plyr)
  let originalPlyr = null;
  let processedPlyr = null;
  initPlayers();

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    selectedFile = file || null;
    if (selectedFile) {
      const url = URL.createObjectURL(selectedFile);
      originalAudio.src = url;

      // Reset processed state
      processedAudio.removeAttribute('src');
      processedAudio.load();
      disableDownload();

      if (originalPlyr) originalPlyr.volume = 0.5;
    }
  });

  processBtn.addEventListener('click', async () => {
    if (!selectedFile) {
      alert('Пожалуйста, выберите аудиофайл.');
      return;
    }

    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

      const arrayBuffer = await selectedFile.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));

      let wavBlob = await window.processAudioBuffer(audioContext, decoded, PROCESS_OPTIONS);

      if (EQ_STATE.enabled) {
        // Decode the processed WAV back to buffer, run offline EQ, then re-encode
        const processedArrayBuf = await wavBlob.arrayBuffer();
        const processedBuffer = await audioContext.decodeAudioData(processedArrayBuf.slice(0));
        const eqBuffer = await renderEqWithOfflineContext(processedBuffer, getActiveEqGains());
        wavBlob = window._speechTrimmer.audioBufferToWavBlob(eqBuffer);
      }

      const processedUrl = URL.createObjectURL(wavBlob);
      processedAudio.src = processedUrl;
      processedAudio.load();
      if (processedPlyr) processedPlyr.volume = 0.5;

      enableDownload(processedUrl, selectedFile.name);
      showToast();
    } catch (err) {
      console.error(err);
      alert('Не удалось обработать файл. Подробности в консоли.');
    }
  });

  // (Parameters line removed for cleaner UI)

  function applyOptionsToControls(opts) {
    silenceThresholdInput.value = String(opts.silenceThreshold);
    silenceThresholdValue.textContent = Number(opts.silenceThreshold).toFixed(3);
    minSilenceMsInput.value = String(opts.minSilenceMs);
    minSilenceMsValue.textContent = String(opts.minSilenceMs);
    overlapMsInput.value = String(opts.overlapMs);
    overlapMsValue.textContent = String(opts.overlapMs);
  }

  function bindControlUpdates() {
    silenceThresholdInput.addEventListener('input', () => {
      PROCESS_OPTIONS.silenceThreshold = Number(silenceThresholdInput.value);
      silenceThresholdValue.textContent = PROCESS_OPTIONS.silenceThreshold.toFixed(3);
      // live value updated in UI
    });

    minSilenceMsInput.addEventListener('input', () => {
      PROCESS_OPTIONS.minSilenceMs = Math.round(Number(minSilenceMsInput.value));
      minSilenceMsValue.textContent = String(PROCESS_OPTIONS.minSilenceMs);
      // live value updated in UI
    });

    overlapMsInput.addEventListener('input', () => {
      PROCESS_OPTIONS.overlapMs = Math.round(Number(overlapMsInput.value));
      overlapMsValue.textContent = String(PROCESS_OPTIONS.overlapMs);
      // live value updated in UI
    });
  }

  function enableDownload(href, originalName) {
    const base = (originalName || 'processed').replace(/\.[^/.]+$/, '');
    downloadLink.href = href;
    downloadLink.download = `${base}-processed.wav`;
    downloadLink.classList.remove('disabled');
    downloadLink.setAttribute('aria-disabled', 'false');
  }

  function disableDownload() {
    downloadLink.href = '#';
    downloadLink.classList.add('disabled');
    downloadLink.setAttribute('aria-disabled', 'true');
  }

  // ------- Toast -------
  let toastTimer = null;
  function showToast() {
    if (!toast) return;
    toast.hidden = false;
    // Force reflow for transition
    void toast.offsetWidth;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => { toast.hidden = true; }, 200);
    }, 3400);
  }

  // ------- EQ helpers -------
  function initEqUI() {
    // Initial values
    enableEq.checked = false;
    eqPreset.value = 'warm';
    updateEqCustomOutputs();
    toggleEqCustomVisibility();

    enableEq.addEventListener('change', () => {
      EQ_STATE.enabled = enableEq.checked;
    });

    eqPreset.addEventListener('change', () => {
      EQ_STATE.mode = eqPreset.value;
      if (EQ_STATE.mode !== 'custom') {
        // Apply preset values into custom sliders for visibility
        const { lowDb, midDb, highDb } = presetToGains(EQ_STATE.mode);
        eqLow.value = String(lowDb);
        eqMid.value = String(midDb);
        eqHigh.value = String(highDb);
        updateEqCustomOutputs();
      }
      toggleEqCustomVisibility();
    });

    eqLow.addEventListener('input', () => {
      EQ_STATE.lowDb = Number(eqLow.value);
      eqPreset.value = 'custom';
      EQ_STATE.mode = 'custom';
      toggleEqCustomVisibility();
      updateEqCustomOutputs();
    });
    eqMid.addEventListener('input', () => {
      EQ_STATE.midDb = Number(eqMid.value);
      eqPreset.value = 'custom';
      EQ_STATE.mode = 'custom';
      toggleEqCustomVisibility();
      updateEqCustomOutputs();
    });
    eqHigh.addEventListener('input', () => {
      EQ_STATE.highDb = Number(eqHigh.value);
      eqPreset.value = 'custom';
      EQ_STATE.mode = 'custom';
      toggleEqCustomVisibility();
      updateEqCustomOutputs();
    });
  }

  function toggleEqCustomVisibility() {
    const isCustom = eqPreset.value === 'custom';
    eqCustomGroup.hidden = !isCustom;
  }

  // ------- Players (Plyr) -------
  function initPlayers() {
    if (window.Plyr) {
      try {
        originalPlyr = new Plyr(originalAudio, { controls: ['play', 'progress', 'current-time', 'mute', 'volume'] });
        processedPlyr = new Plyr(processedAudio, { controls: ['play', 'progress', 'current-time', 'mute', 'volume'] });
        originalPlyr.volume = 0.5;
        processedPlyr.volume = 0.5;
      } catch (_) {
        // ignore
      }
    }
  }

  function updateEqCustomOutputs() {
    eqLowValue.textContent = `${Number(eqLow.value).toFixed(0)} dB`;
    eqMidValue.textContent = `${Number(eqMid.value).toFixed(0)} dB`;
    eqHighValue.textContent = `${Number(eqHigh.value).toFixed(0)} dB`;
  }

  function getActiveEqGains() {
    if (eqPreset.value === 'custom') {
      return {
        lowDb: Number(eqLow.value),
        midDb: Number(eqMid.value),
        highDb: Number(eqHigh.value),
      };
    }
    return presetToGains(eqPreset.value);
  }

  function presetToGains(preset) {
    switch (preset) {
      case 'clear':
        // Clear Voice: lighter low, +presence, +air
        return { lowDb: -3, midDb: +4, highDb: +2 };
      case 'warm':
        // Warm & Natural: +low, gentle -upper mids, tiny high shelf
        return { lowDb: +2, midDb: -2, highDb: +1 };
      case 'cinematic':
        // Cinematic / Deep: strong low, small mid cut, a bit of high
        return { lowDb: +5, midDb: -3, highDb: +2 };
      default:
        return { lowDb: 0, midDb: 0, highDb: 0 };
    }
  }

  async function renderEqWithOfflineContext(inputBuffer, gains) {
    // Render via OfflineAudioContext so we can export as WAV
    const sampleRate = inputBuffer.sampleRate;
    const length = inputBuffer.length;

    // Ensure mono rendering (the processed buffer is mono; if not, average)
    let mono;
    if (inputBuffer.numberOfChannels > 1) {
      const tmp = new Float32Array(length);
      for (let ch = 0; ch < inputBuffer.numberOfChannels; ch++) {
        const chData = inputBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) tmp[i] += chData[i];
      }
      for (let i = 0; i < length; i++) tmp[i] /= inputBuffer.numberOfChannels;
      mono = tmp;
    } else {
      mono = inputBuffer.getChannelData(0).slice();
    }

    const offline = new OfflineAudioContext(1, length, sampleRate);
    const buffer = offline.createBuffer(1, length, sampleRate);
    buffer.copyToChannel(mono, 0);

    const src = offline.createBufferSource();
    src.buffer = buffer;

    // Three-band EQ: low shelf (120 Hz), peaking (3 kHz), high shelf (10 kHz)
    const low = offline.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 120;
    low.gain.value = gains.lowDb;

    const mid = offline.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 3000;
    mid.Q.value = 0.9; // gentle bandwidth
    mid.gain.value = gains.midDb;

    const high = offline.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 10000;
    high.gain.value = gains.highDb;

    src.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(offline.destination);

    src.start(0);
    const rendered = await offline.startRendering();
    return rendered;
  }
})();


