set -eu
flock --help | grep -q -- --no-fork
install -d -o root -g root -m 0755 /run/smithers-workspace-coding
touch /run/smithers-workspace-coding/workspace.lock
chmod 0644 /run/smithers-workspace-coding/workspace.lock
runuser -u node -- sh <<'CHILD'
set -eu
path=/run/smithers-workspace-coding/workspace.lock
[ ! -w /run/smithers-workspace-coding ]
flock --nonblock --no-fork --conflict-exit-code 75 "$path" node -e 'process.stdout.write("ready\n"); setInterval(() => {}, 1000)' > /tmp/host-ready &
first=$!
trap 'kill "$first" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do [ -s /tmp/host-ready ] && break; sleep .01; done
test -s /tmp/host-ready
set +e
flock --nonblock --no-fork --conflict-exit-code 75 "$path" node -e 'process.stdout.write("UNEXPECTED SECOND HOST\n")'
status=$?
set -e
test "$status" -eq 75
printf 'second host refused before Node initialization (75)\n'
kill "$first"
wait "$first" || true
flock --nonblock --no-fork --conflict-exit-code 75 "$path" node -e 'process.stdout.write("replacement acquired after first exit\n")'
trap - EXIT
CHILD
