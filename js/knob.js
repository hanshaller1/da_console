// A rotary knob: drag up/down, mouse wheel, arrow keys, double-click resets.

const A0 = -135, A1 = 135;
const polar = (a, r) => {
  const rad = ((a - 90) * Math.PI) / 180;
  return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)];
};
const arc = (a, b, r) => {
  const [x0, y0] = polar(a, r), [x1, y1] = polar(b, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export class Knob {
  constructor(el, { onInput, onGrab, onRelease, onReset }) {
    this.el = el;
    this.value = 0;
    this.onInput = onInput;
    el.classList.add('knob');
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.innerHTML = `
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
        <path class="track" d="${arc(A0, A1, 46)}"></path>
        <path class="val" d=""></path>
      </svg>
      <div class="cap"><div class="mark"></div></div>`;
    this.cap = el.querySelector('.cap');
    this.valPath = el.querySelector('.val');

    let startY = 0, startV = 0, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
      dragging = true; startY = e.clientY; startV = this.value;
      el.classList.add('active');
      onGrab && onGrab();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const scale = e.shiftKey ? 900 : 220;
      this.input(startV + (startY - e.clientY) / scale);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('active');
      onRelease && onRelease();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      onGrab && onGrab();
      this.input(this.value - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02));
      clearTimeout(this.wheelT);
      this.wheelT = setTimeout(() => onRelease && onRelease(), 400);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.005 : 0.02;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { this.input(this.value + step); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { this.input(this.value - step); e.preventDefault(); e.stopPropagation(); }
    });
    el.addEventListener('dblclick', () => onReset && onReset());
  }

  input(v) {
    v = Math.min(1, Math.max(0, v));
    if (v === this.value) return;
    this.set(v);
    this.onInput(v);
  }

  set(v) {
    this.value = v;
    const a = A0 + (A1 - A0) * v;
    this.cap.style.transform = `rotate(${a}deg)`;
    this.valPath.setAttribute('d', v > 0.002 ? arc(A0, a, 46) : '');
    this.el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }
}
