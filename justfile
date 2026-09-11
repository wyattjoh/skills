set shell := ["sh", "-eu", "-c"]

repo_dir := justfile_directory()
home_dir := home_directory()
agents_dir := repo_dir / "agents"
target_dir := home_dir / ".claude" / "agents"

# Link every agent under agents/ into ~/.claude/agents/.
link:
    #!/bin/sh
    set -eu

    mkdir -p "{{ target_dir }}"

    for source in "{{ agents_dir }}"/*.md; do
        target="{{ target_dir }}/$(basename "$source")"

        if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
            continue
        elif [ -e "$target" ] || [ -L "$target" ]; then
            echo "Skipping existing path: $target" >&2
        else
            ln -s "$source" "$target"
            echo "Linked: $target"
        fi
    done

# Remove only symlinks that still point at this checkout.
unlink:
    #!/bin/sh
    set -eu

    for source in "{{ agents_dir }}"/*.md; do
        target="{{ target_dir }}/$(basename "$source")"

        if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
            rm "$target"
            echo "Removed: $target"
        fi
    done
