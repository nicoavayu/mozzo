const ADMIN_SOUND_STORAGE_KEY = 'mozzo-admin-sounds-enabled';

const SOUND_THROTTLE_BY_EVENT = {
  new_order: 1800,
  call_waiter: 1400,
  request_bill: 1200,
};

const SOUND_CONFIG = {
  new_order: {
    url: '/sounds/new-order-bell.wav',
    gain: 1.65,
    segments: [{ offset: 0, duration: 0.95 }],
  },
  request_bill: {
    url: '/sounds/request-bill-register.wav',
    gain: 1.7,
    segments: [{ offset: 0, duration: 1.08 }],
  },
  call_waiter: {
    url: '/sounds/call-waiter-bell.wav',
    gain: 2.2,
    segments: [
      { offset: 0, duration: 0.75 },
      { offset: 0, duration: 0.75, delay: 0.28 },
      { offset: 0, duration: 0.75, delay: 0.56 },
    ],
  },
};

export function readAdminSoundPreference() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true;
  }

  const storedValue = window.localStorage.getItem(ADMIN_SOUND_STORAGE_KEY);

  if (storedValue == null) {
    return true;
  }

  return storedValue !== '0';
}

export function writeAdminSoundPreference(enabled) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  window.localStorage.setItem(ADMIN_SOUND_STORAGE_KEY, enabled ? '1' : '0');
}

export function getAdminSoundEventForTableRequest(requestType) {
  return requestType === 'request_bill' ? 'request_bill' : 'call_waiter';
}

function getAudioContextConstructor() {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.AudioContext || window.webkitAudioContext || null;
}

async function loadAudioBuffer(audioContext, url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`No pudimos cargar ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer);
}

function playBufferSegments(audioContext, masterGain, buffer, config) {
  const segments = Array.isArray(config?.segments) && config.segments.length > 0
    ? config.segments
    : [{ offset: 0, duration: Math.min(buffer.duration, 1) }];
  const baseTime = audioContext.currentTime + 0.01;

  segments.forEach((segment) => {
    const offset = Math.max(0, Number(segment.offset || 0));
    const duration = Math.min(
      Math.max(0.08, Number(segment.duration || buffer.duration)),
      Math.max(0.08, buffer.duration - offset)
    );
    const delay = Math.max(0, Number(segment.delay || 0));
    const startAt = baseTime + delay;
    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    const peakGain = Math.max(0.25, Number(config?.gain || 1));

    source.buffer = buffer;
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + Math.max(0.04, duration));

    source.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(startAt, offset, duration);
    source.stop(startAt + duration + 0.02);
  });
}

export function createAdminSoundController() {
  const AudioContextConstructor = getAudioContextConstructor();

  if (!AudioContextConstructor) {
    return {
      unlock: async () => false,
      play: async () => false,
      destroy: async () => {},
    };
  }

  let audioContext = null;
  let masterGain = null;
  const lastPlayedByEvent = new Map();
  const loadedBuffers = new Map();
  const loadingPromises = new Map();

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new AudioContextConstructor();
      masterGain = audioContext.createGain();
      masterGain.gain.value = 0.95;
      masterGain.connect(audioContext.destination);
    }

    return audioContext;
  }

  async function ensureBufferLoaded(eventType) {
    if (loadedBuffers.has(eventType)) {
      return loadedBuffers.get(eventType);
    }

    if (loadingPromises.has(eventType)) {
      return loadingPromises.get(eventType);
    }

    const nextAudioContext = ensureAudioContext();
    const config = SOUND_CONFIG[eventType];

    if (!config?.url) {
      return null;
    }

    const promise = loadAudioBuffer(nextAudioContext, config.url)
      .then((buffer) => {
        loadedBuffers.set(eventType, buffer);
        loadingPromises.delete(eventType);
        return buffer;
      })
      .catch((error) => {
        loadingPromises.delete(eventType);
        throw error;
      });

    loadingPromises.set(eventType, promise);
    return promise;
  }

  async function unlock() {
    const nextAudioContext = ensureAudioContext();

    if (nextAudioContext.state === 'suspended') {
      await nextAudioContext.resume();
    }

    return nextAudioContext.state === 'running';
  }

  async function play(eventType) {
    const throttleMs = SOUND_THROTTLE_BY_EVENT[eventType] || 1000;
    const now = Date.now();
    const lastPlayedAt = lastPlayedByEvent.get(eventType) || 0;

    if (now - lastPlayedAt < throttleMs) {
      return false;
    }

    const nextAudioContext = ensureAudioContext();

    if (nextAudioContext.state === 'suspended') {
      try {
        await nextAudioContext.resume();
      } catch {
        return false;
      }
    }

    if (nextAudioContext.state !== 'running' || !masterGain) {
      return false;
    }

    let buffer = loadedBuffers.get(eventType);

    if (!buffer) {
      try {
        buffer = await ensureBufferLoaded(eventType);
      } catch {
        return false;
      }
    }

    const config = SOUND_CONFIG[eventType];

    if (!buffer || !config) {
      return false;
    }

    lastPlayedByEvent.set(eventType, now);
    playBufferSegments(nextAudioContext, masterGain, buffer, config);
    return true;
  }

  async function destroy() {
    if (!audioContext) {
      return;
    }

    try {
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    } catch {
      // Ignore teardown errors from browsers that already disposed the context.
    }
  }

  return {
    unlock,
    play,
    destroy,
  };
}
