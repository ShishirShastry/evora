# Contributing to Evora

Thank you for helping. Evora is a free, open-source design tool, and it gets better with every bug report, idea, plugin and pull request.

## Ways to help

- **Try it and tell us what broke.** Open a [bug report](https://github.com/ShishirShastry/evora/issues/new?template=bug_report.yml) with the steps, your system and, if you can, a screenshot.
- **Ask a question or share an idea** in [Discussions](https://github.com/ShishirShastry/evora/discussions). Feature requests that are ready to be built go in a [feature request](https://github.com/ShishirShastry/evora/issues/new?template=feature_request.yml).
- **Pick up a starter task.** Issues labelled [good first issue](https://github.com/ShishirShastry/evora/labels/good%20first%20issue) are small and say where to start. Comment on one to say you are taking it.
- **Write a plugin.** The [plugin guide](plugins/PLUGINS.md) has the API and four examples.
- **Improve the docs.** The [user guide](docs/user-guide.md), [self-hosting guide](docs/self-hosting.md) and [API reference](docs/api.md) are plain Markdown.
- **Star the repository.** It helps other people find Evora.

Security problems go privately through [SECURITY.md](SECURITY.md), never in a public issue.

## Set up

You need [Node.js](https://nodejs.org/) 20.19 or later and Git.

```bash
git clone https://github.com/ShishirShastry/evora.git
cd evora
npm install
npm run dev        # the app in your browser, with hot reload
npm run desktop    # or the desktop app
npm run server     # the collaboration server, for working on teamwork features
```

Where things live is in the README's [project layout](README.md#build-with-us), and how they fit together is in [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md). The file format is described in [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md).

## Make a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Add or update tests next to the code you changed (`*.test.ts`, run by Vitest).
4. Run the checks before you push:

   ```bash
   npm run check      # TypeScript and the unit tests
   npm run e2e        # browser tests, for changes to the interface (they use Microsoft Edge)
   ```

5. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
6. Open the pull request and fill in its template. Screenshots or a short screen recording help a lot for interface changes.

Write the interface's words the way the rest of Evora does: plain, short and in sentence case, naming things by what people do with them.

## Licence

By contributing you agree that your work is released under the project's [MIT License](LICENSE).

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md). Be kind, assume good intent, and keep discussions about the work.
