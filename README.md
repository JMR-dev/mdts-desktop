# mdts Desktop

A desktop app for browsing and previewing folders of Markdown, built on
[mdts](https://github.com/unhappychoice/mdts) and Electron. Work in progress.

## Development

Requires Node 26 (see `.nvmrc`) and npm 11.

```sh
npm ci
npm run check      # format, lint, typecheck, exception audit
npm run test:unit  # Vitest, 100% coverage gate
```

Type-safety escape hatches, lint suppressions and coverage exemptions are only
allowed with an entry in `exceptions.json`; `npm run audit:exceptions` enforces
this.

## License

MIT. mdts is MIT-licensed by its authors.
