/**
 * Small synthesised sound set. Nothing is loaded from disk: every sound is a
 * few oscillators and an envelope, which keeps the app tiny and instant.
 */
'use strict';

const Sound = (() => {
  let context = null;
  let master = null;
  let enabled = true;

  function ensureContext() {
    if (context) return context;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
    return context;
  }

  function blip({ freq, to, duration = 0.09, type = 'triangle', gain = 0.16, delay = 0 }) {
    const ctx = ensureContext();
    if (!ctx) return;
    const start = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(to, start + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** Short filtered noise burst — the physical "click" under the tone. */
  function click({ gain = 0.05, delay = 0, duration = 0.03 } = {}) {
    const ctx = ensureContext();
    if (!ctx) return;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600;
    filter.Q.value = 1.1;

    const env = ctx.createGain();
    env.gain.value = gain;

    source.connect(filter).connect(env).connect(master);
    source.start(ctx.currentTime + delay);
  }

  function resume() {
    const ctx = ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  const api = {
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) resume();
    },

    /** The satisfying one: a crisp click and a rising two-note pop. */
    complete() {
      if (!enabled) return;
      resume();
      click({ gain: 0.055 });
      blip({ freq: 784, to: 880, duration: 0.07, gain: 0.15 });
      blip({ freq: 1175, to: 1245, duration: 0.11, gain: 0.115, delay: 0.052 });
    },

    levelUp() {
      if (!enabled) return;
      resume();
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        blip({ freq, duration: 0.22, type: 'triangle', gain: 0.13, delay: i * 0.075 });
      });
      blip({ freq: 1567.98, duration: 0.5, type: 'sine', gain: 0.07, delay: 0.3 });
    },

    undo() {
      if (!enabled) return;
      resume();
      blip({ freq: 420, to: 300, duration: 0.11, type: 'sine', gain: 0.1 });
    },

    remove() {
      if (!enabled) return;
      resume();
      blip({ freq: 260, to: 190, duration: 0.09, type: 'sine', gain: 0.09 });
      click({ gain: 0.03 });
    },
  };

  return api;
})();
