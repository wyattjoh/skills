<!-- source: https://devenv.sh/blog/2025/07/25/devenv-devlog-processes-are-now-tasks/
     upstream: docs/src/content/docs/blog/2025/07/25/devenv-devlog-processes-are-now-tasks.md
     llms-full.txt lines 2324-2394 -->

# devenv devlog: Processes are now tasks

Building on the [task runner](/tasks/), devenv now exposes all processes as tasks named `devenv:processes:<name>`.

Now you can run tasks before or after a process runs - addressing a [frequently requested feature](https://github.com/cachix/devenv/issues/1471) for orchestrating the startup sequence.

## Usage

### Execute setup tasks before the process starts

devenv.nix

```nix
{
  processes.backend = {
    exec = "cargo run --release";
  };

  tasks."db:migrate" = {
    exec = "diesel migration run";
    before = [ "devenv:processes:backend" ];
  };
}
```

When you run `devenv up` or the individual process task, migrations run first.

### Run cleanup after the process stops

devenv.nix

```nix
{
  processes.app = {
    exec = "node server.js";
  };

  tasks."app:cleanup" = {
    exec = ''
      rm -f ./server.pid
      rm -rf ./tmp/*
    '';
    after = [ "devenv:processes:app" ];
  };
}
```

## Implementation

Under the hood, process-compose now runs processes through `devenv-tasks run --mode all devenv:processes:<name>` instead of executing them directly. This preserves all existing process functionality while adding task capabilities.

The `--mode all` flag ensures that both `before` and `after` tasks are executed, maintaining the expected lifecycle behavior.

## What’s next?

Future work on process dependencies ([#2037](https://github.com/cachix/devenv/issues/2037)) will also address native health check support ([process-compose#371](https://github.com/F1bonacc1/process-compose/issues/371)), eliminating the need for manual polling scripts.

Domen
