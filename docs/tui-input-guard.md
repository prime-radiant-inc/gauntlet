# TUI input guard

For trusted observer instrumentation, `gauntlet run --adapter tui
--tui-input-guard /absolute/path/to/executable` invokes that executable before
typing, key presses, and the shared bash tool. Combined submit guards typing
and Enter separately. The executable receives one JSON line on stdin:

```json
{"name":"type","args":{"text":"The reply"}}
```

Only exit status 0 permits dispatch. An error, signal, timeout (10 seconds),
or excessive output blocks the operation. Escape, Ctrl+C, and adapter cleanup
remain available. An omitted or invalid flag value is rejected. Runs without
this option retain their normal input behavior; batch/server runs do not enable
it implicitly.

The hook runs in Gauntlet's environment, outside the subject's terminal. Its
stdout/stderr and elapsed time are recorded in `tui_input_guard` events, never
typed into the subject conversation. Keep output bounded and free of secrets.
Pin the hook and its dependencies along with the experiment's instrument.

This is an evidence hook for a trusted grader, not a shell sandbox. It runs
before a bash command, so that command must not both modify an artifact and
submit input using those changed bytes. External processes and independent
review remain outside this boundary. The caller owns artifact discovery,
immutable publication, and semantic review; successful capture alone says
nothing about whether the subject followed a skill correctly.
