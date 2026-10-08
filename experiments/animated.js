'use strict';

// Repaints on every animation frame so screencast gaps measure capture capacity
const bar = document.getElementById('bar');
const clock = document.getElementById('clock');
const t0 = performance.now();

(function tick(now) {
  const t = (now - t0) / 1000;
  bar.style.transform = `translateX(${(t * 400) % innerWidth}px)`;
  clock.textContent = t.toFixed(3);
  requestAnimationFrame(tick);
})(t0);
