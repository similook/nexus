---
name: Feature request
about: Suggest something
title: ''
labels: enhancement
assignees: ''
---

## What problem does this solve?

<!-- Describe the situation you are in, not the solution you have in mind. The most useful
     feature requests explain what goes wrong today. -->

## What would you expect to happen?

## Battery cost

<!--
Worth reading before asking for anything that polls, refreshes, or keeps something alive.

Idle power is the metric this project is built around (docs/adr/ADR-0001). Anything on a timer
wakes the cellular radio, and the radio is the dominant battery cost on a phone. That is why
there is no live throughput in the notification, and why latency polling stops the moment the
app is backgrounded.

Requests like that are not refused outright — but they need a reason strong enough to pay for
the wakeups, and they usually end up behind an explicit user action rather than running by
default.
-->

- [ ] This would need a timer, a background service, or periodic network activity
- [ ] This runs only when the user asks for it
