<p align="center">
  <a href="https://hedlo.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/hedlo-logo-dark.svg">
      <img src="assets/hedlo-logo.svg" alt="Hedlo" width="222" height="64">
    </picture>
  </a>
</p>

<h1 align="center">Hedlo Kit</h1>

<p align="center">The shared platform layer behind Loom, Bolt and the Hedlo Marketplace.</p>

<p align="center">
  <a href="https://hedlo.io">Website</a> &nbsp;|&nbsp;
  <a href="https://hedlo.io/docs">Documentation</a> &nbsp;|&nbsp;
  <a href="https://hedlo.io/security">Security</a>
</p>

Hedlo Kit holds the parts that every Hedlo application needs and that should behave the same everywhere: accounts and sign-in, roles and tenancy, plugins, branding, content, email templates, translations and the user interface components. Loom and Bolt are built on it, and so is any application that wants to look and feel like part of Hedlo.

The kit is built on [Weft](https://www.npmjs.com/package/@weft-framework/core), a server-rendered web framework with live updates, and runs on Node.js 22.6 or newer.

## Packages

| Package | Purpose |
| --- | --- |
| `@hedlo/kit` | The platform services: authentication, passkeys and two-factor sign-in, OAuth, access and tenancy, the activity log, the sealed secret vault, settings, plugins and their slots, widgets, dashboards, navigation, branding, content, email templates, translations, GDPR export and erasure |
| `@hedlo/kit-ui` | The Weft components that give every Hedlo app the same shell, forms, tables, editors, overlays, status indicators and storefront blocks |

## Installation

```sh
npm install @hedlo/kit @hedlo/kit-ui
```

The UI components are copied into your application so you own them and can adjust them. Run the sync command from the app folder:

```sh
npx kit-ui-sync src/components/kit
```

## Plugins

Applications built on the kit share one plugin format. A plugin is an npm-style package with a manifest that declares its id, version, the host versions it supports and the capabilities it needs. Hosts check signatures, show the requested capabilities before installation and load each plugin into named slots, so a plugin never patches application files. The format is documented in the Loom repository and on [hedlo.io/docs](https://hedlo.io/docs).

## Design rules

The components use theme tokens only, never fixed colours, so every installation can apply its own brand. All user-facing text goes through translation catalogs, with English and German included. The `ui/lint-tokens.mjs` script checks the colour rule.

## Security

Please report vulnerabilities privately. The process and contact details are on [hedlo.io/security](https://hedlo.io/security).

## License

Hedlo Kit is open source. The license is published with the first release.
