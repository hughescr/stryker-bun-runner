#!/bin/sh
# Machine-wide benchmark lock (Linux flock), shared by every git worktree.
#
#   sh bench/lock.sh --exclusive|--shared [--nowait] -- <cmd...>
#
#   --exclusive  benchmarks: waits for every running dev check, blocks all others.
#   --shared     dev checks: many may run together, none while a benchmark runs.
#                The command runs under `nice -n 19 ionice -c 3`.
#   --nowait     do not wait: exit 75 (EX_TEMPFAIL) if the lock is not free.
#
# Lock file: ${STRYKER_BENCH_LOCK:-/tmp/stryker-bun-runner-bench.lock} (an absolute
# path outside the repo, so all worktrees contend on the same lock). The lock is
# held on an inherited file descriptor, so it lasts as long as the command or any
# process it left running, and the kernel releases it if everything dies.
#
# Holder info (pid, mode, cwd, command, start time) goes to ${lock}.holder for an
# exclusive holder and ${lock}.holder.<pid> for each shared holder, and is removed
# on exit. Stale entries (dead pid) are ignored.
#
# An exclusive waiter leaves ${lock}.waiting.<pid>; new shared acquirers hold off
# while one exists, so a stream of dev checks cannot starve a benchmark.
#
# The command sees STRYKER_BENCH_LOCK_HELD=exclusive|shared, STRYKER_BENCH_LOCK
# (the lock path) and STRYKER_BENCH_LOCK_PID (this script's pid).

set -u

usage() {
    echo "usage: sh bench/lock.sh --exclusive|--shared [--nowait] -- <cmd...>" >&2
    exit 64
}

mode=
nowait=0
while [ $# -gt 0 ]; do
    case $1 in
        --exclusive) mode=exclusive ;;
        --shared)    mode=shared ;;
        --nowait)    nowait=1 ;;
        --)          shift; break ;;
        -h|--help)   usage ;;
        *)           echo "bench/lock.sh: unknown option: $1" >&2; usage ;;
    esac
    shift
done
[ -n "$mode" ] && [ $# -gt 0 ] || usage

lock=${STRYKER_BENCH_LOCK:-/tmp/stryker-bun-runner-bench.lock}
case $lock in
    /*) ;;
    *) echo "bench/lock.sh: STRYKER_BENCH_LOCK must be an absolute path: $lock" >&2; exit 64 ;;
esac

# Already inside a lock that covers this request (e.g. a benchmark shelling out to
# a check): flock would deadlock against our own parent, so run directly.
held=${STRYKER_BENCH_LOCK_HELD:-}
if [ -n "$held" ] && [ "${STRYKER_BENCH_LOCK:-}" = "$lock" ]; then
    if [ "$held" = exclusive ] || [ "$mode" = shared ]; then
        exec "$@"
    fi
    echo "bench/lock.sh: cannot upgrade a shared lock to exclusive from inside it" >&2
    exit 64
fi

command -v flock >/dev/null 2>&1 || { echo "bench/lock.sh: flock(1) not found (util-linux required)" >&2; exit 69; }

if [ "$mode" = exclusive ]; then
    flock_mode=-x
    holder=$lock.holder
else
    flock_mode=-s
    holder=$lock.holder.$$
fi
waiting=$lock.waiting.$$

# Print live holders ("pid mode cwd cmd since") of the lock, one per line.
live_holders() {
    for f in "$lock.holder" "$lock".holder.*; do
        [ -f "$f" ] || continue
        read -r pid _rest < "$f" || continue
        case $pid in ''|*[!0-9]*) continue ;; esac
        if kill -0 "$pid" 2>/dev/null; then cat "$f"; fi
    done
}

# Any live exclusive waiter other than us?
exclusive_waiting() {
    for f in "$lock".waiting.*; do
        [ -f "$f" ] || continue
        pid=${f##*.}
        case $pid in ''|*[!0-9]*) continue ;; esac
        if [ "$pid" != "$$" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
        [ "$pid" = "$$" ] || rm -f "$f"
    done
    return 1
}

cleanup() {
    rm -f "$holder" "$waiting"
}
child=
on_signal() {
    if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi
    cleanup
    exit 143
}
trap cleanup EXIT
trap on_signal INT TERM HUP

# Open (never truncate) the lock file; make it usable by other users, best effort.
if ! { : >> "$lock"; } 2>/dev/null; then
    echo "bench/lock.sh: cannot open lock file $lock" >&2
    exit 73
fi
chmod 666 "$lock" 2>/dev/null || true
exec 9>> "$lock"

if [ "$mode" = shared ] && [ "$nowait" = 0 ]; then
    # Writer preference: let a waiting benchmark go first.
    announced=0
    while exclusive_waiting; do
        if [ "$announced" = 0 ]; then
            echo "waiting for bench lock: a benchmark is queued ahead of shared work" >&2
            announced=1
        fi
        sleep 1
    done
fi

flock -n -E 75 $flock_mode 9
rc=$?
if [ "$rc" -ne 0 ]; then
    if [ "$rc" -ne 75 ]; then
        echo "bench/lock.sh: flock failed (exit $rc)" >&2
        exit "$rc"
    fi
    if [ "$nowait" = 1 ]; then
        info=$(live_holders | head -n 1)
        echo "bench lock busy${info:+ (held by $info)}" >&2
        exit 75
    fi
    [ "$mode" = exclusive ] && : > "$waiting"
    info=$(live_holders | head -n 3 | tr '\n' ';')
    echo "waiting for bench lock held by ${info:-unknown holder (see $lock.holder)}" >&2
    flock $flock_mode 9 || exit $?
    rm -f "$waiting"
fi

printf '%s %s cwd=%s since=%s cmd=%s\n' \
    "$$" "$mode" "$(pwd)" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" > "$holder"

export STRYKER_BENCH_LOCK_HELD=$mode
export STRYKER_BENCH_LOCK=$lock
export STRYKER_BENCH_LOCK_PID=$$

# Run in the background so a TERM/INT to this script reaches the command; stdin is
# passed through fd 8 (a non-interactive shell would otherwise give it /dev/null).
if ( exec 8<&0 ) 2>/dev/null; then exec 8<&0; else exec 8</dev/null; fi
if [ "$mode" = shared ]; then
    if command -v ionice >/dev/null 2>&1 && ionice -c 3 true 2>/dev/null; then
        nice -n 19 ionice -c 3 "$@" <&8 8<&- &
    else
        nice -n 19 "$@" <&8 8<&- &
    fi
else
    "$@" <&8 8<&- &
fi
child=$!
wait "$child"
rc=$?
# `wait` returns early (>128) if a trapped signal arrived; on_signal handles that.
exit "$rc"
