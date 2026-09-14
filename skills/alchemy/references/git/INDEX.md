# git index

22 pages. A pluggable, embeddable, self-hostable git server on Cloudflare Workers, Durable Objects, and R2. Smart HTTP for any client, a typed REST plane with pull requests, and a GitHub-compatible API, assembled in one file.

| Page | File | Covers |
| --- | --- | --- |
| Git | `_overview.md` | A pluggable, embeddable, self-hostable git server on Cloudflare Workers, Durable Objects, and R2. Smart HTTP for any client, a typed REST plane with pull requests, and a GitHub-compatible API, assembled in one file. |
| Cloning & pushing | `clone-and-push.md` | Standard git clients over smart HTTP. What the wire supports, where credentials go, and what to do when something hangs. |
| Getting Started | `getting-started.md` | Deploy a git host to Cloudflare and push your first repository, in one file. The tutorial then builds the same file from empty. |
| GitHub API compatibility | `github-api.md` | Point the gh CLI and Octokit at your host with the /api/v3 facade. |
| Pull requests | `pull-requests.md` | Server-side merge base, tree diffs, and fast-forward or three-way merges, computed inside the repository. |
| Repositories | `repositories.md` | Create, fork, import, and manage repositories over the typed REST plane. |

## blocks/

| Page | File | Covers |
| --- | --- | --- |
| Overview | `blocks/_overview.md` | One layer graph, provided once, builds the Worker and every Durable Object behind it. Each line is a decision with implementations you choose or write. |
| Auth | `blocks/auth.md` | The engine holds no users, no credentials, and no policy. The middleware of the API that mounts the routes decides who may call them, and Git.Hooks decides which refs may move. |
| Blob Store | `blocks/blob-store.md` | Bulk, immutable, content-addressed bytes. R2 by default, S3 when data has to live in AWS, or any store that can do ranged reads and multipart writes. |
| Hasher | `blocks/hasher.md` | Every object a push sends is inflated and hashed before a ref moves. That is CPU, and where it runs is a Layer, in the Worker, in dynamically loaded Workers, or on Lambda. |
| Registry | `blocks/registry.md` | The registry resolves owner/name to a repository and serves listings. Keep it in a Durable Object or move it to a D1 database. |
| Repository | `blocks/repositories.md` | One Durable Object per repository, behind the Git.RepoStore service. Provide it, call it from your own routes, wrap it to hook pushes and ref updates, or implement its shape over another store. |
| Server | `blocks/server.md` | Every plane as one HttpApi of route classes. Groups you can pick, Handlers you can replace one at a time, Server.layer to serve it behind your middleware, and ServerLive as the open default. |

## recipes/

| Page | File | Covers |
| --- | --- | --- |
| Overview | `recipes/_overview.md` | Requirements pick lines. One table from what you need to the line that changes, the stack shape for one cloud or two, and complete files to copy. |
| Bytes in S3, hashing on Lambda | `recipes/cloudflare-aws.md` | Compute on Cloudflare, bytes in S3, and large pushes hashed one Lambda per chunk. One stack carries both provider sets, and Alchemy mints the cross-cloud identity. |
| All on Cloudflare | `recipes/cloudflare.md` | A git host on one Cloudflare account. One Worker, one bucket, two Durable Object namespaces, and dynamically loaded Workers hashing large pushes. |
| Scaling | `recipes/scaling.md` | Reads scale like a CDN and writes scale like git. The shape, the per-repository limits, the measured numbers, and a worked example of pushing something large and swapping the hasher. |
| Bring your own store | `recipes/your-own-store.md` | Bytes have to live somewhere that is neither R2 nor S3. Implement the five operations of Git.BlobStore and provide it in place of the shipped Layers. |

## tutorial/

| Page | File | Covers |
| --- | --- | --- |
| Part 1: A git server in one file | `tutorial/part-1.md` | Build the git host from an empty file. Each line you add is one decision, and by the end you have deployed it. |
| Part 2: Repositories | `tutorial/part-2.md` | Create a repository on your host, push to it, then let anyone read a public one. The REST plane and the shared secret, used before anything else depends on them. |
| Part 3: Your own API | `tutorial/part-3.md` | Git.Server is designed to be embedded. Build your own API around it with Better Auth, add a route of your own, replace one of the engine's, and serve your application from the same origin. |
| Part 4: Your own rules | `tutorial/part-4.md` | git's pre-receive hook as a service. Protect main, let a team share a repository, and answer from your own data. It never sees a credential. |
