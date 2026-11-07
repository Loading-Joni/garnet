(function () {
  var VARIANTS = {
    1: 'v1/index.html',
    2: 'v2/index.html',
    3: 'v3/index.html'
  }

  var frame = document.getElementById('sw-frame')
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.sw-tabs button'))

  function variantFromUrl() {
    var match = /[?&]v=([123])\b/.exec(window.location.search)
    return match ? Number(match[1]) : null
  }

  function show(n, push) {
    if (!VARIANTS[n]) return
    frame.setAttribute('src', VARIANTS[n])
    buttons.forEach(function (button) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.variant) === n))
    })
    document.title = 'Гарнет — Вариант ' + n
    var url = new URL(window.location.href)
    url.searchParams.set('v', String(n))
    window.history[push ? 'pushState' : 'replaceState']({ variant: n }, '', url)
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      show(Number(button.dataset.variant), true)
    })
  })

  document.addEventListener('keydown', function (event) {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
    if (event.key >= '1' && event.key <= '3') show(Number(event.key), true)
  })

  window.addEventListener('popstate', function () {
    show(variantFromUrl() || 3, false)
  })

  show(variantFromUrl() || 3, false)
})()
