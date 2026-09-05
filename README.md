# The Claude Company Solana tower

The published site for **solana.claudedotcompany.com** — the Solana world that used
to live at `claudedotcompany.com/solana`.

This repository holds BUILT OUTPUT only. Nothing here is edited by hand: the source
is `viewer/` in [Claude-Company](https://github.com/gtjvv976mb-netizen/Claude-Company),
and this site is regenerated from `npm run build` there by
`scripts/publish-solana-site.sh`. Editing a file here would be overwritten on the next
publish and would silently diverge from the desk it describes.

- `index.html` is the Solana homepage (`viewer/solana.html`), with its two
  "back to the two towers" links repointed at the apex.
- `tower.html`, `floor.html`, `buy.html` and `assets/` are copied unchanged.
- `CNAME` binds the custom domain.

The apex `claudedotcompany.com` remains the gateway; the Robinhood world is at
`robinhood.claudedotcompany.com`.
