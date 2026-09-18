<!-- source: https://alchemy.run/neon/setup
     upstream: website/src/content/docs/neon/setup.mdx
     alchemy 2.0.0-beta.79 @ 258f63b -->

# Setup

> Connect alchemy to Neon — account, credentials, and profiles.

Sign up at [neon.tech](https://neon.tech) and create an API key in
the [Neon console](https://console.neon.tech). Register the provider
next to your cloud's:

```typescript
// alchemy.run.ts
import * as Neon from "alchemy/Neon";

providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
```

Run `alchemy profile edit --add Neon`. The API key is entered interactively
and saved under `~/.alchemy/credentials/<profile>/neon-stored.json`.

In CI (`CI=true`), Alchemy skips profiles. Set `NEON_API_KEY` and Alchemy
reads it directly without persisting anything.

See [Profiles](/environments/profiles) for how credentials are stored
and switched.

## Next steps

- [Neon overview](/neon) — resources and compositions.
