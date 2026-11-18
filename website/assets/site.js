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

  // ---- The right download for this computer. ----
  // Without this script the buttons lead to the list of every download, and
  // each file link in the page points at a real file of the current version.
  var platform = '';
  try {
    var uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/Win/i.test(uaPlatform) || /Windows/i.test(ua)) platform = 'windows';
    else if (/Android/i.test(ua)) platform = 'android';
    else if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(uaPlatform) && navigator.maxTouchPoints > 1)) platform = 'ios';
    else if (/Mac/i.test(uaPlatform) || /Mac OS X/i.test(ua)) platform = 'mac';
    else if (/Linux|X11|CrOS/i.test(uaPlatform + ua)) platform = 'linux';
  } catch (error) { /* unknown platform: offer every download */ }

  // Each file the page links to, and how to find it in a release.
  var ASSETS = {
    'windows-installer': /^Evora-Setup-[\d.]+\.exe$/,
    'windows-portable': /^Evora-[\d.]+-portable\.exe$/,
    'mac-arm64': /^Evora-[\d.]+-arm64\.dmg$/,
    'mac-x64': /^Evora-[\d.]+-x64\.dmg$/,
    'linux-appimage': /^Evora-[\d.]+-x86_64\.AppImage$/,
    'linux-deb': /^evora_[\d.]+_amd64\.deb$/
  };

  // Most Macs sold since 2020 have Apple silicon. Chrome and Edge can say for
  // sure; elsewhere Apple silicon is assumed and Intel is one click away.
  var macArch = 'arm64';

  var PLATFORMS = {
    windows: { name: 'Windows', asset: 'windows-installer', label: 'Download for Windows', detail: '' },
    mac: { name: 'macOS', asset: 'mac-arm64', label: 'Download for macOS', detail: 'Apple silicon' },
    linux: { name: 'Linux', asset: 'linux-appimage', label: 'Download for Linux', detail: 'AppImage' }
  };

  function el(tag, text, attrs) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (attrs) Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function assetLink(key, text) {
    var source = document.querySelector('.platforms [data-asset="' + key + '"]');
    return el('a', text, { href: source ? source.getAttribute('href') : '#platforms', 'data-asset': key });
  }

  function noteFor(name) {
    var note = document.createDocumentFragment();
    if (name === 'mac') {
      note.appendChild(document.createTextNode(macArch === 'x64' ? 'For Macs with an Intel processor. Apple silicon Mac? ' : 'For Apple silicon Macs (M1 and later). Intel Mac? '));
      note.appendChild(assetLink(macArch === 'x64' ? 'mac-arm64' : 'mac-x64', macArch === 'x64' ? 'Get the Apple silicon version' : 'Get the Intel version'));
      note.appendChild(document.createTextNode('.'));
    } else if (name === 'linux') {
      note.appendChild(document.createTextNode('Runs on any 64-bit distribution. On Debian or Ubuntu? '));
      note.appendChild(assetLink('linux-deb', 'Get the .deb'));
      note.appendChild(document.createTextNode('.'));
    } else if (name === 'windows') {
      note.appendChild(document.createTextNode('Also for '));
      note.appendChild(el('a', 'macOS and Linux', { href: '#platforms' }));
      note.appendChild(document.createTextNode('.'));
    } else if (name === 'android' || name === 'ios') {
      note.appendChild(document.createTextNode('Evora is a desktop app for Windows, macOS and Linux. Open this page on a computer to download it.'));
    }
    return note;
  }

  function applyPlatform() {
    var choice = PLATFORMS[platform];
    if (choice && platform === 'mac') {
      choice.asset = macArch === 'x64' ? 'mac-x64' : 'mac-arm64';
      choice.detail = macArch === 'x64' ? 'Intel' : 'Apple silicon';
    }
    document.querySelectorAll('[data-platform-note]').forEach(function (node) {
      node.textContent = '';
      node.appendChild(noteFor(platform));
    });
    if (!choice) return;
    var file = document.querySelector('.platforms [data-asset="' + choice.asset + '"]');
    var size = document.querySelector('[data-asset-size="' + choice.asset + '"]');
    document.querySelectorAll('[data-primary-download]').forEach(function (link) {
      if (file) {
        link.href = file.getAttribute('href');
        link.setAttribute('data-asset', choice.asset);
      }
    });
    document.querySelectorAll('[data-primary-label]').forEach(function (node) { node.textContent = choice.label; });
    document.querySelectorAll('[data-primary-size]').forEach(function (node) {
      node.textContent = (choice.detail ? ' \u00b7 ' + choice.detail : '') + (size ? ' \u00b7 ' + size.textContent : '');
    });
    document.querySelectorAll('[data-os-name]').forEach(function (node) { node.textContent = choice.name; });
    document.querySelectorAll('.platform').forEach(function (card) {
      var mine = card.getAttribute('data-platform') === platform;
      card.classList.toggle('is-current', mine);
      var badge = card.querySelector('.platform-badge');
      if (badge) badge.hidden = !mine;
    });
  }

  applyPlatform();

  if (platform === 'mac' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (values) {
      if (values && values.architecture === 'x86') { macArch = 'x64'; applyPlatform(); }
    }).catch(function () { /* keep Apple silicon */ });
  }

  // ---- The newest files, from GitHub Releases. ----
  // The links in the page already point at the current version; this only
  // moves them on when a newer release is published. A file that a newer
  // release lacks keeps its link to the version in the page.
  function formatSize(bytes) {
    return Math.round(bytes / (1024 * 1024)) + ' MB';
  }

  if (!window.fetch) return;
  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (release) {
      if (!release || !release.assets || !release.tag_name) return;
      var found = {};
      release.assets.forEach(function (asset) {
        Object.keys(ASSETS).forEach(function (key) {
          if (ASSETS[key].test(asset.name)) found[key] = asset;
        });
      });
      if (!found['windows-installer']) return;
      Object.keys(found).forEach(function (key) {
        document.querySelectorAll('[data-asset="' + key + '"]').forEach(function (link) {
          link.href = found[key].browser_download_url;
        });
        document.querySelectorAll('[data-asset-size="' + key + '"]').forEach(function (node) {
          node.textContent = formatSize(found[key].size);
        });
      });
      var version = String(release.tag_name).replace(/^v/, '');
      document.querySelectorAll('[data-version]').forEach(function (node) { node.textContent = version; });
      applyPlatform();
    })
    .catch(function () { /* offline or rate-limited: keep the links in the page */ });
})();
