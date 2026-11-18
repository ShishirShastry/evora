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

  // ---- Reveal sections as they scroll into view. ----
  var items = document.querySelectorAll('.reveal');
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
