# Hosting the flasher for free on GitHub Pages

`apps/web` is a static site (Svelte + Vite, Renegade compiled to WASM). It needs
no server, so **GitHub Pages hosts it for free with HTTPS** — and HTTPS is
required, because the flasher uses **WebUSB**, which only works in a secure
context (and in a Chromium browser: Chrome / Edge).

## One-time setup (you, in the repo settings)

1. Open the repo on GitHub → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

That's it. There is nothing to pay and no custom server.

## How it deploys

`.github/workflows/pages.yml` runs on every push to `fajita` that touches
`apps/web/` (and on manual dispatch). It builds the site with the base path set
to the repo sub-path and publishes it:

```sh
gh workflow run "web (GitHub Pages)" -R ferdza/bergamota-farita --ref fajita
```

The site is then at:

- **https://ferdza.github.io/bergamota-farita/** — the landing page
- **https://ferdza.github.io/bergamota-farita/flash/** — the flasher / control plane

## The base path

Because a project Pages site is served under `/<repo>/`, the build passes
`BERGA_BASE=/bergamota-farita/`. Vite rewrites asset URLs for that base, and the
hand-written links use `import.meta.env.BASE_URL`, so everything resolves under
the sub-path. For root hosting (e.g. Cloudflare) leave `BERGA_BASE` unset
(default `/`).

## Notes

- Use **Chrome or Edge** on a desktop. WebUSB is not in Firefox/Safari.
- The browser never uploads your IPSW or firmware anywhere — Renegade (WASM) runs
  entirely on your machine; Pages only serves the static page.
- First-time visit on the Pages URL: the phone picker appears when you click
  Connect (WebUSB device chooser). On Linux, make sure your user can access the
  device (udev / `plugdev`), as for `fastboot`.
