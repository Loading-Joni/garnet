/* Garnet — поведение страницы. Без сборки и зависимостей; сеть используется только
   приёмником форм и счётчиком, которые включаются настройками в site-data.js. */
(function () {
  'use strict';

  var D = window.SITE, P = window.PRICE_LIST || [];
  var byCode = {};
  P.forEach(function (r) { byCode[r.code] = r; });

  function fmt(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
  }
  function price(code) { var r = byCode[code]; return r ? r.rub : null; }
  function name(code) { var r = byCode[code]; return r ? r.name : code; }
  function money(v) { return fmt(v) + ' \u20bd'; }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* ————— 1. числа прайса в разметке ————— */

  function hydratePrices() {
    document.querySelectorAll('[data-price]').forEach(function (node) {
      var v = price(node.getAttribute('data-price'));
      if (v == null) { node.textContent = '—'; return; }
      node.textContent = node.hasAttribute('data-plain') ? fmt(v) : money(v);
    });
    document.querySelectorAll('[data-name]').forEach(function (node) {
      node.textContent = name(node.getAttribute('data-name'));
    });
  }

  /* ————— 2. блок «что видно до лечения» ————— */

  function renderProof() {
    var host = document.querySelector('.proof-list');
    if (!host) return;
    host.textContent = '';
    D.proofRows.forEach(function (g) {
      var box = el('div', 'proof-group');
      box.appendChild(el('h3', null, g.group));
      var body = el('tbody');
      g.items.forEach(function (it) {
        var r = byCode[it.code];
        if (!r) return;
        var nm = el('td');
        nm.appendChild(document.createTextNode(r.name));
        nm.appendChild(el('span', 'cd', 'код ' + r.code));
        var row = el('tr');
        row.appendChild(nm);
        row.appendChild(el('td', null, money(r.rub)));
        body.appendChild(row);
      });
      var table = el('table', 'proof-table');
      table.appendChild(body);
      box.appendChild(table);
      host.appendChild(box);
    });
  }

  /* ————— 3. страница прайса ————— */

  /* Строки прайса лежат в HTML страницы «Цены» и в файле price-list.js. Здесь они только
     фильтруются, поэтому страница читается и без JavaScript. */
  function bindPriceSearch() {
    var host = document.getElementById('price-table');
    var input = document.getElementById('price-search');
    if (!host || !input) return;
    var sections = Array.prototype.slice.call(host.querySelectorAll('.pgroup'));

    function apply(q) {
      var needle = q.toLowerCase(), shown = 0;
      sections.forEach(function (sec) {
        var inGroup = 0;
        sec.querySelectorAll('.prow').forEach(function (row) {
          var hit = !needle ||
            (row.getAttribute('data-name') || '').toLowerCase().indexOf(needle) >= 0 ||
            (row.getAttribute('data-code') || '').toLowerCase().indexOf(needle) >= 0;
          row.hidden = !hit;
          if (hit) inGroup++;
        });
        sec.hidden = inGroup === 0;
        shown += inGroup;
      });
      var total = host.querySelectorAll('.prow').length;
      var empty = document.getElementById('price-empty');
      if (empty) empty.hidden = shown !== 0;
      var c = document.getElementById('price-count');
      if (c) {
        c.textContent = (shown === total ? 'В прайсе ' + total + ' строк' : 'Показано ' + shown + ' строк из ' + total) +
          '. Прайс датирован ' + D.meta.priceDate + '.';
      }
    }

    apply('');
    input.addEventListener('input', function () { apply(input.value.trim()); });
    var clear = document.getElementById('price-clear');
    if (clear) clear.addEventListener('click', function () { input.value = ''; apply(''); input.focus(); });
  }

  /* ————— 4. калькулятор состава —————
     Типы шагов: radio (один выбор без количества), radio-qty (один выбор + количество),
     check-qty (флаг + количество). Цены всегда берутся из price-list.js. */

  var calc = { mode: 'tooth', state: null, plan: null };

  function steps() {
    return calc.mode === 'tooth'
      ? D.calculator.tooth.steps
      : [D.calculator.jaw.prosthesis, D.calculator.jaw.implants, D.calculator.jaw.gum];
  }

  function initState() {
    var s = {};
    steps().forEach(function (st) {
      if (st.kind === 'radio' || st.kind === 'radio-qty') {
        s[st.id] = { pick: 0, qty: st.qty || (st.min || 1) };
      } else {
        s[st.id] = { on: !!(st.options[0] && st.options[0].qty), qty: (st.options[0] && st.options[0].qty) || 1 };
      }
    });
    return s;
  }

  function renderCalc() {
    var host = document.getElementById('calc-body');
    if (!host) return;
    if (!calc.state) calc.state = initState();
    host.textContent = '';

    steps().forEach(function (st) {
      var box = el('section', 'calc-step');
      box.appendChild(el('h3', null, st.label));
      if (st.note) box.appendChild(el('p', 'hint', st.note));

      var list = el('div', 'calc-opts');
      box.appendChild(list);
      var st8 = calc.state[st.id];
      var opts = st.options;

      if (st.kind === 'radio' || st.kind === 'radio-qty') {
        opts.forEach(function (o, i) {
          var row = el('label', 'opt');
          var input = el('input');
          input.type = 'radio';
          input.name = 'calc-' + calc.mode + '-' + st.id;
          input.checked = st8.pick === i;
          row.appendChild(input);
          row.appendChild(el('span', 'lbl', o.label || name(o.code)));
          row.appendChild(el('span', 'cd', o.code || ''));
          row.appendChild(el('span', 'pr', o.code ? money(price(o.code)) : '—'));

          var stepper = null;
          if (st.kind === 'radio-qty' && o.code && st8.pick === i) {
            stepper = qtyControl(st, st8, function () { renderCalc(); });
            row.appendChild(stepper);
          }
          input.addEventListener('change', function () {
            st8.pick = i;
            if (st.kind === 'radio-qty' && st8.qty < (st.min || 1)) st8.qty = st.min || 1;
            renderCalc();
          });
          list.appendChild(row);
        });
      } else {
        var o = opts[0];
        var row = el('label', 'opt');
        var input = el('input');
        input.type = 'checkbox';
        input.name = 'calc-' + calc.mode + '-' + st.id;
        input.checked = st8.on;
        row.appendChild(input);
        row.appendChild(el('span', 'lbl', o.label || name(o.code)));
        row.appendChild(el('span', 'cd', o.code || ''));
        row.appendChild(el('span', 'pr', o.code ? money(price(o.code)) : '—'));
        if (st.kind === 'check-qty') {
          var stepper = qtyControl(st, st8, function () { renderCalc(); });
          row.appendChild(stepper);
          if (!st8.on) stepper.style.visibility = 'hidden';
        }
        input.addEventListener('change', function () {
          st8.on = input.checked;
          renderCalc();
        });
        list.appendChild(row);
      }

      host.appendChild(box);
    });

    updateTotal();
  }

  function qtyControl(st, st8, onChange) {
    var wrap = el('span', 'qty');
    var dec = el('button', null, '\u2212'), out = el('output'), inc = el('button', null, '+');
    dec.type = inc.type = 'button';
    var max = st.maxQty || st.max || 6;
    var min = st.min || 1;
    out.textContent = st8.qty;
    dec.disabled = st8.qty <= min;
    inc.disabled = st8.qty >= max;
    dec.setAttribute('aria-label', 'Уменьшить количество, ' + st.label);
    inc.setAttribute('aria-label', 'Увеличить количество, ' + st.label);
    dec.addEventListener('click', function (ev) { ev.preventDefault(); if (st8.qty > min) { st8.qty--; onChange(); } });
    inc.addEventListener('click', function (ev) { ev.preventDefault(); if (st8.qty < max) { st8.qty++; onChange(); } });
    dec.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    inc.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    wrap.appendChild(dec); wrap.appendChild(out); wrap.appendChild(inc);
    return wrap;
  }

  function collect() {
    var lines = [], total = 0;
    steps().forEach(function (st) {
      var s = calc.state[st.id];
      var chosen = null, qty = 1;
      if (st.kind === 'radio' || st.kind === 'radio-qty') {
        chosen = st.options[s.pick];
        qty = st.kind === 'radio-qty' ? s.qty : 1;
      } else if (s.on) {
        chosen = st.options[0];
        qty = st.kind === 'check-qty' ? s.qty : 1;
      }
      if (!chosen || !chosen.code) return;
      var unit = price(chosen.code);
      if (unit == null) return;
      var sum = unit * qty;
      total += sum;
      lines.push({ code: chosen.code, name: name(chosen.code), unit: unit, qty: qty, sum: sum, step: st.label });
    });
    if (calc.mode === 'tooth') {
      (D.calculator.tooth.included || []).forEach(function (inc) {
        var r = byCode[inc.code];
        if (!r) return;
        lines.push({ code: r.code, name: r.name, unit: 0, qty: 1, sum: 0, step: 'Входит бесплатно' });
      });
    }
    return { mode: calc.mode, lines: lines, total: total };
  }

  function updateTotal() {
    var sumNode = document.getElementById('calc-sum');
    if (!sumNode) return;
    var res = collect();
    calc.plan = res;

    sumNode.textContent = fmt(res.total);
    sumNode.appendChild(el('small', null, ' \u20bd'));

    var list = document.getElementById('calc-lines');
    if (list) {
      list.textContent = '';
      if (!res.lines.length) {
        list.appendChild(el('li', null, 'Отметьте хотя бы одну строку прайса.'));
      }
      res.lines.forEach(function (l) {
        var li = el('li');
        li.textContent = l.code + ' \u00b7 ' + l.name + ' \u00b7 ' +
          (l.qty > 1 ? l.qty + ' \u00d7 ' + money(l.unit) + ' = ' : (l.unit === 0 ? '' : '')) + money(l.sum);
        list.appendChild(li);
      });
    }

    var btn = document.getElementById('calc-send');
    if (btn) {
      btn.textContent = res.total > 0 ? 'Отправить этот план на консультацию' : 'Сначала отметьте строки прайса';
      btn.disabled = res.total <= 0;
    }
    var hint = document.getElementById('calc-total-text');
    if (hint) {
      hint.textContent = 'Ориентир по прайсу от ' + D.meta.priceDate +
        '. Это не смета: точную сумму по вашему случаю врач называет после осмотра и снимка \u2014 и она не меняется в процессе лечения.';
    }
  }

  function calcModeButtons() {
    var host = document.getElementById('calc-modes');
    if (!host) return;
    D.calculator.modes.forEach(function (m) {
      var b = el('button', 'mode-btn', m.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(m.id === calc.mode));
      b.addEventListener('click', function () {
        if (m.id === calc.mode) return;
        calc.mode = m.id;
        calc.state = initState();
        host.querySelectorAll('.mode-btn').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        renderCalc();
        goal('calc_mode', { mode: m.id });
      });
      host.appendChild(b);
    });
  }

  /* ————— 5. аналитика ————— */

  function goal(name_, params) {
    if (!D.analytics.enableMetrika) return;
    try {
      if (typeof window.ym === 'function') window.ym(D.analytics.metrikaId, 'reachGoal', name_, params || {});
    } catch (e) { /* счётчик не загрузился — на работу сайта не влияет */ }
    if (window.console && /[?&]ymdebug/.test(location.search)) console.log('[goal]', name_, params || {});
  }

  /* ————— 6. UTM ————— */

  function utmSnapshot() {
    try { return JSON.parse(sessionStorage.getItem('garnet_utm') || '{}'); }
    catch (e) { return {}; }
  }

  function captureUtm() {
    var q = new URLSearchParams(location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ymclid', 'msclkid', 'gclid', 'clckid'];
    var found = {};
    keys.forEach(function (k) { if (q.get(k)) found[k] = q.get(k); });
    var merged = Object.assign({}, utmSnapshot(), found);
    if (!merged.referrer && document.referrer) merged.referrer = document.referrer;
    try { sessionStorage.setItem('garnet_utm', JSON.stringify(merged)); } catch (e) { /* приватный режим */ }
  }

  function appendUtm() {
    var u = utmSnapshot();
    var qs = Object.keys(u).filter(function (k) { return /^utm_|^ymclid|^msclkid|^gclid|^clckid/.test(k); })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(u[k]); }).join('&');
    if (!qs) return;
    document.querySelectorAll('[data-utm-link]').forEach(function (a) {
      a.href += (a.href.indexOf('?') >= 0 ? '&' : '?') + qs;
    });
  }

  /* ————— 7. формы ————— */

  function phoneValid(v) {
    var d = v.replace(/\D/g, '');
    return d.length >= 10 && d.length <= 12;
  }

  function fieldError(f, msg) {
    var wrap = f.closest('.field') || f.closest('.consent');
    if (!wrap) return;
    wrap.classList.toggle('bad', !!msg);
    var e = wrap.querySelector('.err');
    if (e) e.textContent = msg || '';
  }

  function bindForm(form) {
    var state = form.querySelector('.form-state');
    var submit = form.querySelector('button[type="submit"]');
    var busy = false;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      var trap = form.querySelector('.hp input');
      if (trap && trap.value) return;

      var bad = null;
      form.querySelectorAll('[required]').forEach(function (f) {
        var msg = '';
        if (f.type === 'checkbox' && !f.checked) msg = 'Без согласия на обработку данных мы не можем принять обращение.';
        else if (f.type === 'tel' && !phoneValid(f.value)) msg = 'Введите телефон полностью, например +7 918 222-73-36.';
        else if (!f.value.trim()) msg = 'Заполните это поле.';
        fieldError(f, msg);
        if (msg && !bad) bad = f;
      });
      if (bad) {
        bad.focus();
        state.hidden = false;
        state.dataset.kind = 'error';
        state.textContent = 'Проверьте отмеченные поля.';
        return;
      }

      var fd = new FormData(form);
      var payload = {
        request_id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2),
        sent_at: new Date().toISOString(),
        page: (location.pathname.split('/').pop() || 'index').replace(/\.html?$/i, '') || 'index',
        form: form.dataset.form || 'appointment',
        doctor: fd.get('doctor') || null,
        plan: calc.plan && calc.plan.total > 0 ? calc.plan : null,
        name: String(fd.get('name') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        message: String(fd.get('message') || '').trim(),
        kt: String(fd.get('kt') || '').trim() || null,
        consent: fd.get('consent') === 'on',
        utm: utmSnapshot()
      };

      goal('form_start', { form: payload.form });

      var endpoint = D.forms.endpoint;
      if (!endpoint) { manualMode(form, payload, state); return; }

      busy = true;
      submit.disabled = true;
      var label = submit.textContent;
      submit.textContent = 'Отправляем\u2026';
      state.hidden = false;
      state.dataset.kind = 'sending';
      state.textContent = 'Отправляем…';

      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || body.ok === false) throw new Error('http');
          goal('lead_sent', { form: payload.form });
          location.href = D.forms.successPage + '?from=' + encodeURIComponent(payload.form);
        });
      }).catch(function () {
        state.dataset.kind = 'error';
        state.textContent = '';
        state.appendChild(el('strong', null, 'Не отправилось. '));
        state.appendChild(document.createTextNode('Позвоните '));
        var t = el('a', 'arrowlink', D.contacts.phoneDisplay);
        t.href = 'tel:' + D.contacts.phoneRaw;
        t.setAttribute('data-goal', 'call_after_error');
        state.appendChild(t);
        goal('form_error', { form: payload.form });
      }).then(function () {
        busy = false;
        submit.disabled = false;
        submit.textContent = label;
      });
    });
  }

  /* Приёмник не настроен: не имитируем отправку, а показываем, что происходит на самом деле,
     и отдаём тот же текст заявки в WhatsApp или звонок. */
  function manualMode(form, payload, state) {
    state.hidden = false;
    state.dataset.kind = 'manual';
    state.textContent = '';

    var draft = ['Заявка с сайта Garnet (' + payload.page + ')',
      'Имя: ' + payload.name,
      'Телефон: ' + payload.phone];
    if (payload.doctor) draft.push('Врач: ' + payload.doctor);
    if (payload.message) draft.push('Вопрос: ' + payload.message);
    if (payload.kt) draft.push('Ссылка на КТ: ' + payload.kt);
    if (payload.plan) {
      draft.push('Собранный план по прайсу:');
      payload.plan.lines.forEach(function (l) {
        draft.push('  ' + l.code + ' ' + l.name + (l.qty > 1 ? ' x' + l.qty : '') + ' = ' + money(l.sum));
      });
      draft.push('Итого ориентир: ' + money(payload.plan.total));
    }
    var text = draft.join('\n');

    state.appendChild(el('strong', null, 'Приёмник заявок не настроен \u2014 эта заявка никуда не ушла.'));
    state.appendChild(el('p', 'small', 'В боевой сборке сюда подставляется адрес приёмника в site-data.js (forms.endpoint). Пока он пустой, форма отдаёт тот же текст напрямую:'));

    var links = el('p', 'mt-s');
    var wa = el('a', 'arrowlink', 'Отправить в WhatsApp');
    wa.href = D.contacts.whatsapp + '?text=' + encodeURIComponent(text);
    wa.target = '_blank'; wa.rel = 'noopener';
    wa.setAttribute('data-goal', 'whatsapp_open');
    links.appendChild(wa);
    links.appendChild(document.createTextNode(' \u00b7 '));
    var tel = el('a', 'arrowlink', 'Позвонить ' + D.contacts.phoneDisplay);
    tel.href = 'tel:' + D.contacts.phoneRaw;
    tel.setAttribute('data-goal', 'call_click');
    links.appendChild(tel);
    state.appendChild(links);

    var pre = el('pre', 'small mt-s');
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = text;
    state.appendChild(pre);

    goal('form_blocked', { form: payload.form });
  }

  /* ————— 8. движение и мелочи ————— */

  function reveal() {
    var nodes = document.querySelectorAll('[data-appear]');
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('shown'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('shown'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    nodes.forEach(function (n) {
      var p = n.parentElement;
      var sibs = p ? Array.prototype.filter.call(p.children, function (c) { return c.hasAttribute('data-appear'); }) : [];
      var i = sibs.indexOf(n);
      if (i > 0) n.style.animationDelay = Math.min(i, 6) * 70 + 'ms';
      io.observe(n);
    });
  }

  function dragRow() {
    document.querySelectorAll('.dragrow').forEach(function (row) {
      var down = false, startX = 0, startLeft = 0;
      row.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') return;
        down = true; startX = e.clientX; startLeft = row.scrollLeft;
        row.classList.add('dragging');
      });
      row.addEventListener('pointermove', function (e) {
        if (!down) return;
        row.scrollLeft = startLeft - (e.clientX - startX);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) {
        row.addEventListener(t, function () { down = false; row.classList.remove('dragging'); });
      });
    });
  }

  function burger() {
    var b = document.querySelector('.burger'), nav = document.querySelector('.topnav');
    if (!b || !nav) return;
    b.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'Закрыть' : 'Меню';
    });
  }

  function license() {
    var box = document.querySelector('[data-license]');
    if (!box) return;
    var l = D.license;
    if (l.number && l.date && l.issuer) {
      box.hidden = false;
      box.textContent = 'Лицензия на осуществление медицинской деятельности ' + l.number +
        ' от ' + l.date + ', выдана ' + l.issuer + '.';
    } else {
      box.hidden = true;
    }
  }

  function booking() {
    var host = document.querySelector('[data-medflex]');
    if (!host) return;
    host.hidden = !D.booking.medflexId;
  }

  function bindTracking() {
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest ? ev.target.closest('[data-goal]') : null;
      if (a) goal(a.getAttribute('data-goal'), { section: a.getAttribute('data-section') || null });
    });
  }

  /* Номер и каналы лежат в site-data.js, но в разметке они тоже записаны прямо — чтобы работало без JS.
     Здесь разметка подтягивается к конфигу, и правка номера в одном месте действительно меняет весь сайт. */
  function syncContacts() {
    var c = D.contacts;
    document.querySelectorAll('a[href^="tel:"]').forEach(function (a) {
      if (c.phoneRaw) a.href = 'tel:' + c.phoneRaw;
    });
    document.querySelectorAll('a[href*="wa.me/"]').forEach(function (a) {
      if (c.whatsapp) a.href = c.whatsapp + (a.search || '');
    });
    document.querySelectorAll('a[href*="t.me/"]').forEach(function (a) {
      if (c.telegram) a.href = c.telegram;
    });
    document.querySelectorAll('a[href^="mailto:"]').forEach(function (a) {
      if (c.email) a.href = 'mailto:' + c.email;
    });
  }

  /* ————— запуск ————— */

  function boot() {
    document.documentElement.classList.add('ready');
    captureUtm();
    appendUtm();
    hydratePrices();
    renderProof();
    bindPriceSearch();
    if (document.getElementById('calc-body')) { calcModeButtons(); renderCalc(); }
    document.querySelectorAll('form').forEach(bindForm);
    bindTracking();
    reveal();
    dragRow();
    burger();
    license();
    booking();
    syncContacts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.GarnetGoal = goal;
})();
