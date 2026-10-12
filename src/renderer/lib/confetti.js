/**
 * Level-up confetti. Hand-rolled canvas particles so there is no dependency
 * and nothing running when the app is idle.
 */
'use strict';

const Confetti = (() => {
  const COLOURS = ['#4ade80', '#a3e635', '#22c55e', '#fbbf24', '#e9ebf0', '#34d399'];
  const GRAVITY = 0.00058;
  const DRAG = 0.0022;

  let canvas = null;
  let ctx = null;
  let particles = [];
  let frame = null;
  let lastTime = 0;

  function fit() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function attach(element) {
    canvas = element;
    ctx = canvas.getContext('2d');
    fit();
    window.addEventListener('resize', fit);
  }

  function spawn(originX, originY, count) {
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      const speed = 0.22 + Math.random() * 0.45;
      particles.push({
        x: originX + (Math.random() - 0.5) * 26,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 0.02,
        angle: Math.random() * Math.PI,
        colour: COLOURS[(Math.random() * COLOURS.length) | 0],
        life: 0,
        ttl: 1100 + Math.random() * 700,
        square: Math.random() > 0.35,
      });
    }
  }

  function step(time) {
    const delta = Math.min(34, lastTime ? time - lastTime : 16);
    lastTime = time;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles = particles.filter((p) => {
      p.life += delta;
      if (p.life > p.ttl) return false;

      p.vy += GRAVITY * delta;
      p.vx -= p.vx * DRAG * delta;
      p.x += p.vx * delta;
      p.y += p.vy * delta;
      p.angle += p.spin * delta;

      const fade = p.life > p.ttl * 0.62 ? 1 - (p.life - p.ttl * 0.62) / (p.ttl * 0.38) : 1;

      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.colour;
      if (p.square) {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return true;
    });

    if (particles.length) {
      frame = requestAnimationFrame(step);
    } else {
      frame = null;
      lastTime = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Bursts from a point, given in CSS pixels relative to the viewport. */
  function burst(x, y, count = 90) {
    if (!ctx) return;
    spawn(x, y, count);
    if (!frame) {
      lastTime = 0;
      frame = requestAnimationFrame(step);
    }
  }

  function clear() {
    particles = [];
    if (frame) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { attach, burst, clear };
})();
