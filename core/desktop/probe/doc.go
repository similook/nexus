// Package probe is the per-server Test All probe engine for the desktop daemon.
//
// ============================================================================================
// A MIRROR OF nexuscore's ENGINE, NOT A SECOND ONE
//
// probe.go, probe_platform.go and probe_test.go are byte-for-byte copies of the files of the
// same name in core/nexuscore, with only the package clause changed. mirror_test.go fails the
// build's tests the moment they differ in anything else.
//
// Why a copy rather than an import: nexuscore imports libbox, and nexusd must not link libbox
// (see the note on `version` in cmd/nexusd/main.go - it needs -checklinkname=0 and is mobile
// plumbing a daemon can never call). The engine itself depends only on sing-box, so the same
// code runs here unchanged. Moving it out of nexuscore into a shared package is the clean end
// state; it was not done now because it changes the Android source and binary that passed its
// device tests.
//
// To update after changing the nexuscore originals, from core/:
//
//	for f in probe.go probe_platform.go probe_test.go; do
//	  sed '0,/^package nexuscore$/s//package probe/' nexuscore/$f > desktop/probe/$f
//	done
//
// What is desktop-specific - keeping probe traffic out of an active tunnel, and resolving
// server names outside it - lives in desktop/ipc/probe.go, which feeds this engine its targets
// and its resolver. Nothing in here knows it is on a desktop.
// ============================================================================================
package probe

// proxyTag is the outbound every generated config tunnels through (singboxConfig.ts). In
// nexuscore it is declared in fetch.go, which is not part of the mirror.
const proxyTag = "proxy"
