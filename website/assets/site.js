// Evora website. Everything here is an extra: the page works without it.
(function () {
  'use strict';

  var REPO = 'ShishirShastry/evora';

  // ---- Header: border once scrolled, and the menu on small screens. ----
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.menu-toggle');
  function onScroll() {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (header && toggle) {
    var setOpen = function (open) {
      header.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    toggle.addEventListener('click', function () {
      setOpen(!header.classList.contains('menu-open'));
    });
    header.querySelectorAll('.nav a').forEach(function (link) {
      link.addEventListener('click', function () { setOpen(false); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && header.classList.contains('menu-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Reveal sections as they scroll into view, siblings one after another. ----
  var items = document.querySelectorAll('.reveal');
  items.forEach(function (item) {
    var siblings = item.parentElement ? item.parentElement.querySelectorAll(':scope > .reveal') : [];
    var index = Array.prototype.indexOf.call(siblings, item);
    if (index > 0 && !reduceMotion) item.style.transitionDelay = Math.min(index, 6) * 0.08 + 's';
  });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (item) { observer.observe(item); });
  } else {
    items.forEach(function (item) { item.classList.add('is-visible'); });
  }

  function whenVisible(node, callback) {
    if (!node) return;
    if (!('IntersectionObserver' in window)) { callback(); return; }
    var seen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { seen.disconnect(); callback(); }
    }, { threshold: 0.35 });
    seen.observe(node);
  }

  // ---- Numbers count up the first time they are seen. ----
  document.querySelectorAll('[data-count]').forEach(function (node) {
    if (reduceMotion) return;
    var target = Number(node.getAttribute('data-count'));
    var suffix = node.getAttribute('data-suffix') || '';
    var final = node.textContent;
    whenVisible(node, function () {
      var start = null;
      var duration = 1400;
      function frame(time) {
        if (start === null) start = time;
        var t = Math.min(1, (time - start) / duration);
        var eased = 1 - Math.pow(1 - t, 4);
        node.textContent = Math.round(target * eased).toLocaleString('en-US') + suffix;
        if (t < 1) requestAnimationFrame(frame); else node.textContent = final;
      }
      requestAnimationFrame(frame);
    });
  });

  // ---- A spotlight that follows the pointer over cards. ----
  document.querySelectorAll('.card, .mini').forEach(function (card) {
    card.addEventListener('pointermove', function (event) {
      var box = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - box.left) + 'px');
      card.style.setProperty('--my', (event.clientY - box.top) + 'px');
    });
  });

  // ---- The terminal types its commands when it scrolls into view. ----
  var term = document.querySelector('[data-terminal]');
  if (term && !reduceMotion) {
    var lines = Array.prototype.slice.call(term.querySelectorAll('.line'));
    var texts = lines.map(function (line) {
      var t = line.querySelector('.t');
      return t ? t.textContent : null;
    });
    var replay = term.parentElement.querySelector('.term-replay');
    var cursor = term.querySelector('.cursor');
    var run = 0;

    var wait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

    var play = function () {
      var id = ++run;
      if (replay) replay.hidden = true;
      lines.forEach(function (line, i) {
        line.classList.add('is-hidden');
        line.classList.remove('is-new');
        var t = line.querySelector('.t');
        if (t && texts[i] !== null) t.textContent = '';
      });
      var chain = wait(350);
      lines.forEach(function (line, i) {
        chain = chain.then(function () {
          if (id !== run) return;
          line.classList.remove('is-hidden');
          var t = line.querySelector('.t');
          var text = texts[i];
          if (!t || !text) {
            line.classList.add('is-new');
            if (cursor && line.classList.contains('idle')) line.appendChild(cursor);
            return wait(line.classList.contains('c') ? 450 : 170);
          }
          // A command: the cursor moves to it and types it out.
          if (cursor) line.appendChild(cursor);
          term.classList.add('is-typing');
          var typed = 0;
          var step = function () {
            if (id !== run) return Promise.resolve();
            if (typed >= text.length) {
              term.classList.remove('is-typing');
              return wait(text.length > 40 ? 650 : 380);
            }
            typed += 1;
            t.textContent = text.slice(0, typed);
            var ch = text.charAt(typed - 1);
            return wait(ch === ' ' ? 45 : 16 + Math.random() * 30).then(step);
          };
          return wait(260).then(step);
        });
      });
      chain.then(function () {
        if (id === run && replay) replay.hidden = false;
      });
    };

    lines.forEach(function (line) { line.classList.add('is-hidden'); });
    whenVisible(term, play);
    if (replay) replay.addEventListener('click', play);
  }

  // ---- A note for people who are not on Windows. ----
  var platform = '';
  try {
    var uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/Win/i.test(uaPlatform) || /Windows/i.test(ua)) platform = 'windows';
    else if (/Android/i.test(ua)) platform = 'android';
    else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'ios';
    else if (/Mac/i.test(uaPlatform) || /Mac OS X/i.test(ua)) platform = 'mac';
    else if (/Linux|X11|CrOS/i.test(uaPlatform + ua)) platform = 'linux';
  } catch (error) { /* unknown platform: say nothing */ }

  var notes = {
    mac: 'You seem to be on a Mac. The macOS app is coming soon; for now you can download Evora on a Windows PC.',
    linux: 'You seem to be on Linux. The Linux app is coming soon; for now you can download Evora on a Windows PC.',
    android: 'Evora is a desktop app. Open this page on a Windows PC to download it.',
    ios: 'Evora is a desktop app. Open this page on a Windows PC to download it.'
  };
  if (notes[platform]) {
    document.querySelectorAll('[data-platform-note]').forEach(function (node) {
      node.textContent = notes[platform];
    });
  }

  // ---- The newest Windows installer, from GitHub Releases. ----
  // The links in the page already point at version 0.1.0; this only moves
  // them on when a newer release is published.
  function formatSize(bytes) {
    return Math.round(bytes / (1024 * 1024)) + ' MB';
  }

  if (!window.fetch) return;
  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (release) {
      if (!release || !release.assets || !release.tag_name) return;
      var version = String(release.tag_name).replace(/^v/, '');
      var installer = null;
      var portable = null;
      release.assets.forEach(function (asset) {
        if (/^Evora-Setup-[\d.]+\.exe$/.test(asset.name)) installer = asset;
        if (/^Evora-[\d.]+-portable\.exe$/.test(asset.name)) portable = asset;
      });
      if (!installer) return;
      document.querySelectorAll('[data-download="windows"]').forEach(function (link) {
        link.href = installer.browser_download_url;
      });
      if (portable) {
        document.querySelectorAll('[data-download="portable"]').forEach(function (link) {
          link.href = portable.browser_download_url;
        });
      }
      document.querySelectorAll('[data-version]').forEach(function (node) { node.textContent = version; });
      document.querySelectorAll('[data-size]').forEach(function (node) { node.textContent = formatSize(installer.size); });
    })
    .catch(function () { /* offline or rate-limited: keep the links in the page */ });
})();
