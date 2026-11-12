/* Community Connect — small dependency-free SVG charts (bar, grouped bar, line, horizontal bar).
   Colours come from CSS custom properties on .viz-root so light/dark themes swap in one place.
   Every chart has a hover tooltip and an aria-label; data tables are rendered next to the charts. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function niceStep(max, ticks = 4) {
    if (max <= 0) return 1;
    const raw = max / ticks;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  }
  function scaleMax(values) {
    const max = Math.max(0, ...values);
    const step = niceStep(max || 1);
    return { max: Math.max(step, Math.ceil(max / step) * step), step };
  }

  // One shared tooltip element.
  let tip;
  function tooltip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'viz-tooltip';
      tip.setAttribute('role', 'status');
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(html, evt) {
    const t = tooltip();
    t.innerHTML = html;
    t.classList.add('show');
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY - h - pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y < 8) y = evt.clientY + pad;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  }
  function hideTip() { tip?.classList.remove('show'); }

  /** Re-renders a chart whenever its container width changes. */
  function responsive(el, draw) {
    let lastW = 0;
    const render = () => {
      const w = Math.round(el.clientWidth);
      if (!w || w === lastW) return;
      lastW = w;
      el.innerHTML = '';
      draw(w);
    };
    if (el._ro) el._ro.disconnect();
    el._ro = new ResizeObserver(render);
    el._ro.observe(el);
    lastW = 0; render();
  }

  function svgEl(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  /** Bar path with 4px rounded data-end, square at the baseline. */
  function barPath(x, y, w, h, r = 4) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function legend(series) {
    if (series.length < 2) return '';
    return `<div class="viz-legend">${series.map(s => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}</div>`;
  }
  function wrapLabel(text, max) { const t = String(text); return t.length > max ? t.slice(0, max - 1) + '…' : t; }

  /**
   * Vertical (grouped) bar chart.
   * opts: { categories: [label], series: [{ name, color: '--series-1', values: [] }], format: v => string,
   *         tooltipTitle?: i => string, height?, ariaLabel }
   */
  function bars(el, opts) {
    const { categories, series, format = v => String(v), height = 260 } = opts;
    el.classList.add('viz-chart');
    responsive(el, width => {
      const all = series.flatMap(s => s.values);
      const { max, step } = scaleMax(all);
      const m = { t: 12, r: 8, b: categories.length > 6 || width < 520 ? 58 : 34, l: 46 };
      const W = width, H = height, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' });
      for (let v = 0; v <= max + 1e-9; v += step) {
        const y = m.t + ih - (v / max) * ih;
        svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: v === 0 ? 'viz-baseline' : 'viz-gridline' }, svg);
        svgEl('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'viz-tick' }, svg).textContent = format(v, true);
      }
      const band = iw / categories.length;
      const groupW = Math.min(band * 0.72, series.length * 34);
      const gap = 2;
      const bw = (groupW - gap * (series.length - 1)) / series.length;
      const rotate = categories.length > 6 || width < 520;
      categories.forEach((cat, i) => {
        const gx = m.l + band * i + (band - groupW) / 2;
        const g = svgEl('g', { class: 'viz-group' }, svg);
        series.forEach((s, si) => {
          const v = s.values[i] || 0;
          const h = (v / max) * ih;
          svgEl('path', { d: barPath(gx + si * (bw + gap), m.t + ih - h, bw, h), fill: `var(${s.color})`, class: 'viz-bar' }, g);
        });
        const lx = m.l + band * i + band / 2;
        const label = svgEl('text', { x: lx, y: m.t + ih + 16, class: 'viz-label', 'text-anchor': rotate ? 'end' : 'middle' }, svg);
        if (rotate) label.setAttribute('transform', `rotate(-35 ${lx} ${m.t + ih + 16})`);
        label.textContent = wrapLabel(cat, rotate ? 16 : 14);
        // Hit target: the whole band, taller than the bars.
        const hit = svgEl('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, class: 'viz-hit', tabindex: 0 }, svg);
        const html = () => `<strong>${esc(opts.tooltipTitle ? opts.tooltipTitle(i) : cat)}</strong>${series.map(s =>
          `<div><i style="background:var(${s.color})"></i>${esc(s.name)} <b>${esc(format(s.values[i] || 0))}</b></div>`).join('')}${opts.tooltipExtra ? opts.tooltipExtra(i) : ''}`;
        hit.addEventListener('pointermove', e => { g.classList.add('is-hover'); showTip(html(), e); });
        hit.addEventListener('pointerleave', () => { g.classList.remove('is-hover'); hideTip(); });
        hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); showTip(html(), { clientX: r.left + r.width / 2, clientY: r.top + 20 }); });
        hit.addEventListener('blur', hideTip);
      });
      el.insertAdjacentHTML('beforeend', legend(series));
      el.appendChild(svg);
    });
  }

  /**
   * Line chart with crosshair tooltip. opts as bars(); series values are numbers.
   */
  function line(el, opts) {
    const { categories, series, format = v => String(v), height = 240 } = opts;
    el.classList.add('viz-chart');
    responsive(el, width => {
      const { max, step } = scaleMax(series.flatMap(s => s.values));
      const m = { t: 14, r: 18, b: 34, l: 46 };
      const W = width, H = height, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' });
      for (let v = 0; v <= max + 1e-9; v += step) {
        const y = m.t + ih - (v / max) * ih;
        svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: v === 0 ? 'viz-baseline' : 'viz-gridline' }, svg);
        svgEl('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'viz-tick' }, svg).textContent = format(v, true);
      }
      const x = i => m.l + (categories.length === 1 ? iw / 2 : (iw * i) / (categories.length - 1));
      const y = v => m.t + ih - (v / max) * ih;
      categories.forEach((c, i) => {
        svgEl('text', { x: x(i), y: H - 12, 'text-anchor': i === 0 ? 'start' : i === categories.length - 1 ? 'end' : 'middle', class: 'viz-label' }, svg).textContent = c;
      });
      series.forEach(s => {
        if (opts.area) svgEl('path', { d: `M${x(0)},${y(0)}` + s.values.map((v, i) => `L${x(i)},${y(v)}`).join('') + `L${x(s.values.length - 1)},${y(0)}Z`, fill: `var(${s.color})`, class: 'viz-area' }, svg);
        svgEl('path', { d: s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(''), stroke: `var(${s.color})`, class: 'viz-line' }, svg);
        // Direct label at the end of each line
        const last = s.values.length - 1;
        svgEl('circle', { cx: x(last), cy: y(s.values[last]), r: 4, fill: `var(${s.color})`, class: 'viz-dot' }, svg);
      });
      const cross = svgEl('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, class: 'viz-cross' }, svg);
      const dots = series.map(s => svgEl('circle', { r: 5, fill: `var(${s.color})`, class: 'viz-hover-dot' }, svg));
      const hit = svgEl('rect', { x: m.l - 10, y: m.t, width: iw + 20, height: ih, class: 'viz-hit', tabindex: 0 }, svg);
      const show = (i, e) => {
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.add('show');
        dots.forEach((d, si) => { d.setAttribute('cx', x(i)); d.setAttribute('cy', y(series[si].values[i])); d.classList.add('show'); });
        showTip(`<strong>${esc(opts.tooltipTitle ? opts.tooltipTitle(i) : categories[i])}</strong>${series.map(s =>
          `<div><i style="background:var(${s.color})"></i>${esc(s.name)} <b>${esc(format(s.values[i]))}</b></div>`).join('')}`, e);
      };
      hit.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect();
        const px = (e.clientX - r.left) * (W / r.width);
        const i = Math.max(0, Math.min(categories.length - 1, Math.round(((px - m.l) / iw) * (categories.length - 1))));
        show(i, e);
      });
      hit.addEventListener('pointerleave', () => { cross.classList.remove('show'); dots.forEach(d => d.classList.remove('show')); hideTip(); });
      el.insertAdjacentHTML('beforeend', legend(series));
      el.appendChild(svg);
    });
  }

  /**
   * Horizontal bars with direct value labels (good for long names, e.g. communities).
   * opts: { labels, values, color, format, max?, sub?: i => string }
   */
  function hbars(el, opts) {
    const { labels, values, color = '--series-1', format = v => String(v) } = opts;
    el.classList.add('viz-chart', 'viz-hbars');
    const max = opts.max || Math.max(1, ...values);
    el.innerHTML = `<div role="img" aria-label="${esc(opts.ariaLabel || '')}">${labels.map((l, i) => `
      <div class="viz-hrow" tabindex="0" data-i="${i}">
        <span class="viz-hlabel">${esc(l)}</span>
        <span class="viz-htrack"><span class="viz-hbar" style="width:${Math.max(values[i] > 0 ? 1.5 : 0, (values[i] / max) * 100)}%;background:var(${color})"></span></span>
        <span class="viz-hvalue">${esc(format(values[i]))}${opts.sub ? `<small>${esc(opts.sub(i))}</small>` : ''}</span>
      </div>`).join('')}</div>`;
    el.querySelectorAll('.viz-hrow').forEach(row => {
      const i = Number(row.dataset.i);
      row.addEventListener('pointermove', e => showTip(`<strong>${esc(labels[i])}</strong><div>${esc(opts.tooltip ? opts.tooltip(i) : format(values[i]))}</div>`, e));
      row.addEventListener('pointerleave', hideTip);
    });
  }

  window.CCCharts = { bars, line, hbars, hideTip };
})();
