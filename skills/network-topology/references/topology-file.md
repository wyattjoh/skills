# The topology file

## Contents

- Top level
- `roles`
- `nodes[]` and the grid
- `edges[]` and states
- `groups[]`
- What the build rejects and warns about

Every string marked HTML is inserted as markup, so `<code>`, `<b>`, and `<br>` work. Write a literal `<` or `&` as `&lt;` or `&amp;`. The full worked example is `$SKILL_DIR/scripts/testdata/homelab.topology.json`.

## Top level

| Field       | Type                    | Required | Notes                                                                     |
| ----------- | ----------------------- | -------- | ------------------------------------------------------------------------- |
| `title`     | HTML                    | yes      | Toolbar heading. Also the `<title>` with tags stripped.                   |
| `pageTitle` | string                  | no       | Overrides the `<title>`.                                                  |
| `logo`      | string                  | no       | 1-2 characters in the brand square. Defaults to the title's first letter. |
| `accent`    | CSS color               | no       | Brand square and minimap viewport. Defaults to the template's purple.     |
| `summary`   | HTML                    | no       | Collapsible "About this map" card, top left. Use `<p>` per paragraph.     |
| `layout`    | `{columnGap?, rowGap?}` | no       | Pixels between grid cells. Defaults 180 and 90.                           |
| `roles`     | `Record<id, Role>`      | yes      | Node categories, keyed by id.                                             |
| `nodes`     | `Node[]`                | yes      | At least one.                                                             |
| `edges`     | `Edge[]`                | yes      | May be empty.                                                             |
| `groups`    | `Group[]`               | no       | Dashed boundary boxes drawn around members.                               |

## `roles`

```json
"roles": { "ingress": { "label": "Ingress (tunnel, proxy, tailnet)", "color": "#0d9488" } }
```

A role colours its nodes' icon, border, handles, and minimap block, and lists once in the legend. Pick colours that read on both the light and dark background; the source palette used `#8b8b99` external, `#0d9488` ingress, `#5016FF` control plane, `#2563eb` app, `#d97706` storage, `#db2777` containers, `#64748b` host.

## `nodes[]`

| Field     | Type                         | Notes                                                               |
| --------- | ---------------------------- | ------------------------------------------------------------------- |
| `id`      | string                       | **Required**, unique. Edges and groups refer to it.                 |
| `role`    | string                       | **Required**, a key of `roles`.                                     |
| `column`  | integer ≥ 0                  | **Required.** Grid column.                                          |
| `row`     | integer ≥ 0                  | Grid row. Omit to take the lowest free row in the column.           |
| `icon`    | string                       | 1-3 characters in the coloured square.                              |
| `title`   | HTML                         | **Required.**                                                       |
| `sub`     | HTML                         | Muted line under the title.                                         |
| `rows`    | `[key, value][]`             | Key/value lines on the card; the value renders as code.             |
| `chips`   | HTML[]                       | Dashed pills under the rows.                                        |
| `badge`   | HTML                         | Card footer: the node's identity or trust level (uid, netns, root). |
| `details` | `{heading, html?, items?}[]` | Sections of the side panel opened by clicking the node.             |

Keep the card to what identifies the node at a glance (address, port, one or two facts); put explanation in `details`. Use these `details` headings when they apply, in this order, so every map reads alike: **Listens on**, **Privilege**, **Risks**. Add others after them.

### The grid

Every column is one card wide, and every row is as tall as its tallest card, so rows line up across columns. Place nodes by meaning, not by edge direction:

- Columns run from outside in: external parties left, ingress next, the workloads and control plane in the middle, host resources and dependencies right.
- Rows cluster what belongs to one group, so its boundary box stays compact. Leave a row empty to separate two groups vertically.
- Put the two ends of a busy edge in the same row or adjacent columns; long diagonals across the map are the hardest to read.

A layered (Sugiyama) layout was rejected for this: real topologies have cycles and attack paths that point "backwards", which drags external nodes into the middle, and overlapping groups (a loopback inside a host, a tailnet spanning both) cannot be expressed as the strict hierarchy those engines need. After building, nodes can be dragged in the browser to try an arrangement; write the winning cells back into the file.

## `edges[]`

| Field    | Type                | Notes                                                                     |
| -------- | ------------------- | ------------------------------------------------------------------------- |
| `id`     | string              | **Required**, unique.                                                     |
| `from`   | string              | **Required**, a node id. The arrowhead points at `to`.                    |
| `to`     | string              | **Required**, a different node id.                                        |
| `label`  | HTML                | **Required.** What travels or what is possible: "Tunnel ingress → proxy". |
| `state`  | see below           | Defaults to `allow`.                                                      |
| `side`   | `"left" \| "right"` | Route out of and into the same side of both cards, as a bracket.          |
| `offset` | number              | Pixels to shift the line off-centre. Parallel edges fan out on their own. |
| `note`   | HTML                | Side-panel text: the evidence, the mechanism, what would change it.       |

| `state`   | Drawn as                      | Means                                                  |
| --------- | ----------------------------- | ------------------------------------------------------ |
| `allow`   | solid green, moving dot       | Intended traffic.                                      |
| `risk`    | red dashed, fast moving dot   | Possible and should not be: an exposure.               |
| `partial` | orange dotted                 | Possible but limited; the note says how.               |
| `block`   | grey dotted with a ✕ midpoint | Attempted path that is stopped; the note says by what. |

An edge is one relationship in one direction. Model a request/response exchange as one edge from the initiator; add the reverse only when the far end independently initiates something. Use `side` for edges between nodes in the same column, which otherwise draw straight through the cards between them.

## `groups[]`

| Field           | Type                | Notes                                                                               |
| --------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `id`            | string              | **Required**, unique.                                                               |
| `label`         | string              | **Required.** Plain text drawn on the boundary.                                     |
| `members`       | string[]            | **Required**, node ids. The box is their bounding box plus `pad`.                   |
| `color`         | CSS color           | **Required.**                                                                       |
| `pad`           | number              | Default 24. Give an enclosing group a larger pad than the groups inside it.         |
| `labelPosition` | `"top" \| "bottom"` | Default `top`. Use `bottom` when a group's label would collide with another's.      |
| `legend`        | string              | Lists the group under "Boundaries" in the legend. Groups sharing a value list once. |

A group is a boundary something enforces or shares: a host, a network namespace, a subnet, a uid, a VM. Groups may overlap and nest. Because the box is the members' bounding box, a non-member inside that rectangle looks like a member; move it to another row or column.

## What the build rejects and warns about

Nothing is written when any of these hold, and all of them are listed together:

- a field of the wrong type or a value outside its set, with the JSON path
- a duplicate node, edge, or group id
- a node whose `role` is not a key of `roles`
- an edge or group member naming a node that does not exist, or an edge from a node to itself
- a group listing a member twice
- two nodes in the same column and row

The page is still written, with a warning, for a node with no edges and for a `details` section with neither `html` nor `items`.
