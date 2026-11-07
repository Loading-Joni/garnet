/* Garnet, главная страница.
   Настройки клиники — в CONFIG в начале файла.
   Приёмник заявок: если CONFIG.forms.endpoint пуст, заявка не уходит на сервер,
   а собирается в текст и открывается в WhatsApp. Это рабочий путь без бэкенда;
   как только клиника даст адрес приёмника, впишите его в CONFIG.forms.endpoint. */

var CONFIG = {
  forms: {
    endpoint: '',
    whatsapp: '79182227336',
    telegram: 'garnetstom',
    clinicName: 'Гарнет'
  }
};

(function () {
  'use strict';

  /* ---------- Мобильное меню ---------- */

  var burger = document.querySelector('.burger');
  var nav = document.getElementById('nav');
  var scrim = document.getElementById('nav-scrim');
  var scrollY = 0;

  function lockScroll() {
    scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + scrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }

  function unlockScroll() {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, scrollY);
  }

  function closeNav() {
    if (!nav) return;
    nav.classList.remove('is-open');
    if (burger) burger.setAttribute('aria-expanded', 'false');
    if (scrim) { scrim.classList.remove('is-on'); scrim.hidden = true; }
    unlockScroll();
  }

  if (burger && nav) {
    burger.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (scrim) { scrim.classList.toggle('is-on', open); scrim.hidden = !open; }
      if (open) lockScroll(); else unlockScroll();
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeNav();
    });
  }
  if (scrim) scrim.addEventListener('click', closeNav);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });

  /* ---------- Вкладки ---------- */

  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabBtns.forEach(function (b) {
        var on = b === btn;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        var panel = document.getElementById(b.getAttribute('aria-controls'));
        if (!panel) return;
        panel.classList.toggle('is-on', on);
        if (on) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      });
    });
  });

  /* ---------- Вопросы ---------- */

  Array.prototype.slice.call(document.querySelectorAll('.faq-q')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      var item = btn.closest('.faq-item');
      var answer = item ? item.querySelector('.faq-a') : null;
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (item) item.classList.toggle('is-open', !open);
      if (answer) {
        if (open) answer.setAttribute('hidden', '');
        else answer.removeAttribute('hidden');
      }
    });
  });

  /* ---------- Появление блоков ---------- */

  var appear = Array.prototype.slice.call(document.querySelectorAll('[data-appear]'));
  if (!('IntersectionObserver' in window)) {
    appear.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    appear.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Форма записи ---------- */

  var form = document.getElementById('zapis-form');
  if (!form) return;

  var okBox = document.getElementById('form-ok');
  var okText = document.getElementById('form-text');
  var waBtn = document.getElementById('wa-btn');

  function setError(field, on) {
    var wrap = form.querySelector('[data-field="' + field + '"]');
    if (wrap) wrap.classList.toggle('err', on);
  }

  function digits(value) {
    return (value || '').replace(/\D/g, '');
  }

  function validate() {
    var name = form.elements.name.value.trim();
    var phone = form.elements.phone.value.trim();
    var consent = form.elements.consent.checked;
    var bad = false;

    if (name.length < 2) { setError('name', true); bad = true; } else { setError('name', false); }
    if (digits(phone).length < 10) { setError('phone', true); bad = true; } else { setError('phone', false); }
    if (!consent) { setError('consent', true); bad = true; } else { setError('consent', false); }
    return !bad;
  }

  function buildMessage(data) {
    var lines = [
      'Заявка с сайта garnetstom.ru',
      '',
      'Имя: ' + data.name,
      'Телефон: ' + data.phone
    ];
    if (data.topic) lines.push('Что нужно: ' + data.topic);
    if (data.doctor && data.doctor !== 'Не выбран') lines.push('Врач: ' + data.doctor);
    if (data.comment) lines.push('Комментарий: ' + data.comment);
    lines.push('');
    lines.push('Отправлено с сайта клиники.');
    return lines.join('\n');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate()) {
      var first = form.querySelector('.err input, .err select, .err textarea');
      if (first) first.focus();
      return;
    }

    var data = {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      topic: form.elements.topic.value,
      doctor: form.elements.doctor.value,
      comment: form.elements.comment.value.trim()
    };
    var text = buildMessage(data);
    var waUrl = 'https://wa.me/' + CONFIG.forms.whatsapp + '?text=' + encodeURIComponent(text);

    okText.textContent = text;
    okBox.classList.add('is-on');
    if (waBtn) waBtn.href = waUrl;

    if (CONFIG.forms.endpoint) {
      fetch(CONFIG.forms.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(function () { /* текст заявки уже показан, звонок и мессенджеры работают */ });
    }

    window.open(waUrl, '_blank', 'noopener');
    okBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  var copyBtn = document.getElementById('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text = okText.textContent;
      var done = function () {
        copyBtn.textContent = 'Скопировано';
        setTimeout(function () { copyBtn.textContent = 'Скопировать текст'; }, 2200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (err) {}
        document.body.removeChild(ta);
      }
    });
  }
})();
