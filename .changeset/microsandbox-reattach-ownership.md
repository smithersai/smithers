---
"@smthrs/sandbox": minor
---

`MicrosandboxSandbox` no longer takes over a machine of the same name that
another installation, or another provider, created on a shared Microsandbox
home. Such an acquire fails with a `MicrosandboxReattachRefusal` coded
`ownership_mismatch` and leaves the machine untouched; before, it relabelled
the machine, ran in it, and with ephemeral persistence removed it.

Machines now record a `smithers.configuration` label (image or snapshot, root
disk, `cpus`, `maxCpus`, `memoryMib`, `maxMemoryMib`, `maxDurationSecs`,
`security`). A reattach whose boot source, or any of those it names, differs
is refused with `configuration_mismatch`, so a sticky machine booted under a
weaker security profile is not reused under `security: "restricted"`. Sticky
machines created before this release record no configuration and are refused;
remove them once.
