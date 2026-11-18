# Third-party notices

Evora ships with the following third-party material. Libraries used only to build or test the application are listed in `package.json` and carry their own licences in `node_modules`.

## Inter (font)

- What: the Inter typeface, all nine weights, upright and italic. It is the font new text is set in and the font of the application's own interface, so that both look the same on every machine.
- Where it comes from: the npm package `@fontsource/inter` (version 5.3.0 at the time of writing), which repackages the font files of the Inter project (https://github.com/rsms/inter).
- Copyright: 2016 The Inter Project Authors.
- Licence: SIL Open Font License, Version 1.1. The full text is in [`public/licenses/Inter-OFL-1.1.txt`](public/licenses/Inter-OFL-1.1.txt) and is served with the application at `/licenses/Inter-OFL-1.1.txt`.
- How it is used: the font files are bundled unmodified by the build (`src/fonts.ts` imports the package's style sheets). They are not sold on their own.

## GSAP (website only)

- What: the GSAP animation library and its ScrollTrigger plugin, version 3.15.1. They animate the project website's opening sequence and scroll effects. The Evora application does not use or ship them.
- Where it comes from: the npm package `gsap`; the files `dist/gsap.min.js` and `dist/ScrollTrigger.min.js` are copied unmodified into `website/assets/vendor/`, so the website still makes no outside requests.
- Copyright: 2008-2026 GreenSock.
- Licence: GreenSock's standard "no charge" license, https://gsap.com/standard-license. It is not an open-source licence, which is why the library is used only on the website.
