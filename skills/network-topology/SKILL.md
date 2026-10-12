---
name: network-topology
description: Builds an interactive network-topology map from a JSON description of nodes, edges, and boundaries, showing which paths are intended, at risk, limited, or blocked. Use when the user asks to map or diagram a network topology, show how services, hosts, and networks connect, visualize an isolation or attack surface, or render a topology JSON file as a page.
argument-hint: "[system, repo, or topology.json to map]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(bun:*)
  - Bash(open:*)
---

# Network topology

The deliverable is a topology file, `.scratch/<name>.topology.json`, that describes every node, every relationship between nodes, and every boundary that contains them. The build script validates it and renders it into a self-contained page: pan-and-zoom canvas, node and edge side panels, legend, minimap. The page shell is finished; your work is the model of the system.

## Done when

- Every component that sends, receives, or holds something in scope is a node, including the external parties and host resources (filesystem, sockets, credentials stores) that paths reach.
- Every relationship is an edge with a label saying what travels, and a `state` that you can justify. Every `risk`, `partial`, and `block` edge carries a `note` naming the mechanism (the bind address, the permission, the firewall rule) and its source.
- Every enforced or shared boundary (host, loopback, netns, subnet, uid, VM, overlay network) is a group.
- The build exits 0 with no warnings, and you have opened the page and checked that no group box swallows a non-member and no edge runs through an unrelated card.

## Boundaries

- Ground every node, edge, and state in something you read: config, code, unit files, `ss`/`netstat` output, docs. Where you infer, say so in the `note` ("appears to…"). An edge marked `block` without a named mechanism is a guess.
- Write the topology file and run the build; the template in `$SKILL_DIR/assets/` is shared by every map. When a map needs something the template lacks, tell the user instead of editing it.
- Confirm `.scratch/` is gitignored before writing there.

## Build

```bash
bun $SKILL_DIR/scripts/build.ts .scratch/<name>.topology.json --open
```

`--out <path>` overrides the output, which defaults to the input path with `.html`. On failure the script lists every problem at once with its JSON path or ids; fix them all and rebuild.

## Writing the file

Read [references/topology-file.md](references/topology-file.md) before writing the first file: every field, the state vocabulary, how to place nodes on the grid, and group padding. The tested worked example is `$SKILL_DIR/scripts/testdata/homelab.topology.json`.

Placement is by grid cell (`column`, optional `row`), not pixels. Lay out by meaning: external parties left, ingress, workloads and control plane, host resources right, with each group's members in adjacent cells.

## Hand-off

Give the page path, the counts by state, and the paths you marked `risk`. Name which states rest on inference rather than evidence you read.
